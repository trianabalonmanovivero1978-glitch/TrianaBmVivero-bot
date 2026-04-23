// ============================================================
// TRIANA DIGITAL CORE — Bot Webhook
// Vercel Serverless Function (Node.js)
// Archivo: api/webhook.js
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

// ── Clientes (se inicializan fuera del handler para reutilizar entre llamadas) ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Service Role: puede escribir sin restricciones RLS
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ── System Prompt para Gemini ──────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un experto en balonmano con amplio conocimiento en metodología deportiva, 
táctica y planificación de sesiones de entrenamiento.

Tu única tarea es analizar la descripción de una sesión de entrenamiento y extraer su 
contenido técnico de forma estructurada.

REGLAS ESTRICTAS:
1. Responde ÚNICAMENTE con un objeto JSON válido. Sin texto adicional, sin markdown, sin bloques de código.
2. El JSON debe tener exactamente estos dos campos:
   - "contents": string con el resumen técnico de los contenidos trabajados en la sesión.
   - "objectives": array de strings, cada uno representando un objetivo metodológico concreto.
3. Si la descripción es vaga o incompleta, infiere los objetivos más probables basándote en tu conocimiento de balonmano.
4. Los objetivos deben ser específicos y accionables (ej: "Mejora del lanzamiento en salto desde posición de central").
5. Máximo 5 objetivos por sesión.

EJEMPLO DE SALIDA VÁLIDA:
{
  "contents": "Trabajo de defensa 6:0 con basculaciones, seguido de transición defensa-ataque y finalización en contraataque.",
  "objectives": [
    "Consolidar la estructura defensiva 6:0 con comunicación entre líneas",
    "Mejorar la velocidad de transición defensa-ataque",
    "Desarrollar la finalización en superioridad numérica tras robo de balón"
  ]
}`;

// ── Función auxiliar: enviar mensaje a Telegram ───────────────────────────────
async function sendTelegramMessage(chatId, text, parseMode = "HTML") {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
  } catch (error) {
    console.error("Error enviando mensaje a Telegram:", error.response?.data || error.message);
  }
}

// ── Función auxiliar: procesar /sesion con Gemini ────────────────────────────
async function procesarSesionConGemini(descripcion) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      responseMimeType: "application/json", // Fuerza salida JSON nativa
      temperature: 0.2, // Baja temperatura = respuestas más consistentes y estructuradas
    },
    systemInstruction: SYSTEM_PROMPT,
  });

  const result = await model.generateContent(descripcion);
  const responseText = result.response.text();

  // Parsear y validar el JSON devuelto por Gemini
  const parsed = JSON.parse(responseText);

  if (!parsed.contents || !Array.isArray(parsed.objectives)) {
    throw new Error("Gemini devolvió un JSON con estructura incorrecta.");
  }

  return parsed;
}

// ── Función auxiliar: guardar sesión en Supabase ─────────────────────────────
async function guardarSesionEnSupabase(chatId, telegramUserId, descripcionOriginal, geminiData) {
  // Buscar el entrenador por su telegram_user_id en la tabla de accesos
  const { data: acceso, error: errorAcceso } = await supabase
    .from("telegram_accesos")
    .select("socio_id")
    .eq("telegram_user_id", String(telegramUserId))
    .eq("activo", true)
    .single();

  // Si no está registrado, usamos null (la sesión se guarda igualmente, el DT puede asignarla)
  const entrenadorId = acceso?.socio_id || null;

  const { data, error } = await supabase
    .from("training_sessions")
    .insert({
      entrenador_id: entrenadorId,
      telegram_chat_id: String(chatId),
      telegram_user_id: String(telegramUserId),
      descripcion_original: descripcionOriginal,
      contents: geminiData.contents,
      objectives: geminiData.objectives, // Se guarda como array (tipo jsonb en Supabase)
      fecha: new Date().toISOString().split("T")[0], // YYYY-MM-DD
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Error al insertar en Supabase: ${error.message}`);
  }

  return data;
}

// ── Handler principal de Vercel ───────────────────────────────────────────────
export default async function handler(req, res) {
  // Vercel requiere respuesta rápida — Telegram espera máx. 5 segundos o reintenta
  // Respondemos 200 inmediatamente y procesamos en background
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Triana Bot activo." });
  }

  // Responder 200 a Telegram de inmediato para evitar reintentos
  res.status(200).json({ ok: true });

  // ── Extraer datos del update de Telegram ──────────────────────────────────
  const update = req.body;

  // Solo procesamos mensajes de texto (ignoramos ediciones, fotos, etc.)
  if (!update?.message?.text) return;

  const { message } = update;
  const chatId = message.chat.id;
  const userId = message.from.id;
  const texto = message.text.trim();
  const nombreUsuario = message.from.first_name || "Entrenador";

  // ── Router de comandos ────────────────────────────────────────────────────
  try {
    // ── /start ──────────────────────────────────────────────────────────────
    if (texto === "/start") {
      await sendTelegramMessage(
        chatId,
        `👋 Hola <b>${nombreUsuario}</b>, soy el asistente del <b>Club BM Triana Vivero</b>.\n\n` +
        `Puedes usarme para registrar sesiones de entrenamiento directamente en el panel del Director Técnico.\n\n` +
        `<b>Comandos disponibles:</b>\n` +
        `• <code>/sesion [descripción]</code> — Registra una sesión de entrenamiento\n` +
        `• <code>/ayuda</code> — Muestra esta ayuda\n\n` +
        `<i>Ejemplo:\n/sesion Hoy hemos trabajado defensa 6:0, transiciones y lanzamientos desde extremo derecho durante 75 minutos.</i>`
      );
      return;
    }

    // ── /ayuda ───────────────────────────────────────────────────────────────
    if (texto === "/ayuda" || texto === "/help") {
      await sendTelegramMessage(
        chatId,
        `<b>📋 Cómo registrar una sesión:</b>\n\n` +
        `Escribe <code>/sesion</code> seguido de la descripción de lo que habéis trabajado hoy.\n\n` +
        `<b>Ejemplo:</b>\n` +
        `<code>/sesion Calentamiento con balón, trabajo de bloqueos y liberaciones en ataque posicional, finalización con portero. Duración 90 min.</code>\n\n` +
        `La IA extraerá automáticamente los objetivos y los enviará al panel del DT. ✅`
      );
      return;
    }

    // ── /sesion [descripcion] ─────────────────────────────────────────────────
    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();

      // Validar que hay descripción
      if (!descripcion || descripcion.length < 10) {
        await sendTelegramMessage(
          chatId,
          `⚠️ <b>Descripción muy corta o vacía.</b>\n\n` +
          `Por favor, describe con detalle la sesión de hoy.\n\n` +
          `<i>Ejemplo:\n<code>/sesion Hoy hemos trabajado defensa individual y transición al ataque durante 60 min.</code></i>`
        );
        return;
      }

      // Notificar que estamos procesando (UX: el usuario sabe que algo ocurre)
      await sendTelegramMessage(
        chatId,
        `⏳ <i>Analizando la sesión con IA... un momento.</i>`
      );

      // 1. Procesar con Gemini
      const geminiData = await procesarSesionConGemini(descripcion);

      // 2. Guardar en Supabase
      const sesionGuardada = await guardarSesionEnSupabase(chatId, userId, descripcion, geminiData);

      // 3. Construir mensaje de confirmación con el resumen extraído
      const objetivosFormateados = geminiData.objectives
        .map((obj, i) => `   ${i + 1}. ${obj}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `✅ <b>Sesión registrada correctamente para el Director Técnico.</b>\n\n` +
        `<b>📝 Contenido técnico:</b>\n${geminiData.contents}\n\n` +
        `<b>🎯 Objetivos identificados:</b>\n${objetivosFormateados}\n\n` +
        `<i>ID de sesión: #${sesionGuardada.id} · ${new Date().toLocaleDateString("es-ES")}</i>`
      );

      return;
    }

    // ── Mensaje no reconocido ─────────────────────────────────────────────────
    await sendTelegramMessage(
      chatId,
      `🤖 No entiendo ese mensaje. Usa <code>/ayuda</code> para ver los comandos disponibles.`
    );

  } catch (error) {
    console.error("Error en el handler del bot:", error);

    // Notificar al usuario sin exponer detalles técnicos
    await sendTelegramMessage(
      chatId,
      `❌ <b>Ha ocurrido un error al procesar tu solicitud.</b>\n\n` +
      `Por favor, inténtalo de nuevo en unos segundos. Si el problema persiste, contacta con el administrador.`
    );
  }
}
