// ============================================================
// TRIANA DIGITAL CORE — Bot Webhook
// Vercel Serverless Function (Node.js)
// Archivo: api/webhook.js
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

// ── Clientes ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ── Función auxiliar: Escapar HTML (Mejora 1) ─────────────────────────────────
function escapeHTML(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── System Prompt (Mejora 3: Más limpio para evitar errores) ──────────────────
const SYSTEM_PROMPT = `Eres un experto en balonmano. Analiza la sesión y extrae su contenido técnico.
REGLAS ESTRICTAS:
1. Responde ÚNICAMENTE con un objeto JSON válido. Sin texto adicional ni markdown.
2. No uses símbolos especiales como < > o caracteres de formato extraños.
3. El JSON debe tener exactamente estos dos campos:
   - "contents": string con el resumen técnico de los contenidos trabajados en la sesión.
   - "objectives": array de strings, cada uno representando un objetivo metodológico concreto.
4. Si la descripción es vaga o incompleta, infiere los objetivos más probables basándote en tu conocimiento de balonmano.
5. Los objetivos deben ser específicos y accionables (ej: "Mejora del lanzamiento en salto desde posición de central").
6. Máximo 5 objetivos por sesión.

EJEMPLO DE SALIDA VÁLIDA:
{
  "contents": "Trabajo de defensa 6:0 con basculaciones, seguido de transición defensa-ataque y finalización en contraataque.",
  "objectives": [
    "Consolidar la estructura defensiva 6:0 con comunicación entre líneas",
    "Mejorar la velocidad de transición defensa-ataque",
    "Desarrollar la finalización en superioridad numérica tras robo de balón"
  ]
}`;

// ── Función auxiliar: enviar mensaje a Telegram (Mejora 2: Robustez) ───────────
async function sendTelegramMessage(chatId, text, parseMode = "HTML") {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: parseMode,
    });
  } catch (error) {
    console.error("Error enviando HTML a Telegram, reintentando texto plano...");
    // Si falla el envío con HTML, enviamos el texto limpio de etiquetas
    try {
      const plainText = text.replace(/<[^>]*>?/gm, ''); 
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: plainText,
      });
    } catch (retryError) {
      console.error("Error crítico final:", retryError.message);
    }
  }
}

// ── Función auxiliar: procesar /sesion con Gemini ────────────────────────────
async function procesarSesionConGemini(descripcion) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.1, 
    },
    systemInstruction: SYSTEM_PROMPT,
  });

  const result = await model.generateContent(descripcion);
  const responseText = result.response.text();
  const parsed = JSON.parse(responseText);

  if (!parsed.contents || !Array.isArray(parsed.objectives)) {
    throw new Error("Gemini devolvió un JSON con estructura incorrecta.");
  }

  return parsed;
}

// ── Función auxiliar: guardar sesión en Supabase (Corrección nombre tabla) ────
async function guardarSesionEnSupabase(chatId, telegramUserId, descripcionOriginal, geminiData) {
  const { data: acceso } = await supabase
    .from("telegram_accesos")
    .select("socio_id")
    .eq("telegram_user_id", String(telegramUserId))
    .eq("activo", true)
    .single();

  const entrenadorId = acceso?.socio_id || null;

  // Simplificamos: eliminamos fecha y created_at porque Supabase los genera solo
  const { data, error } = await supabase
    .from("sesiones") 
    .insert({
      entrenador_id: entrenadorId,
      telegram_chat_id: String(chatId),
      telegram_user_id: String(telegramUserId),
      descripcion_original: descripcionOriginal,
      contents: geminiData.contents,
      objectives: geminiData.objectives
    })
    .select()
    .single();

  if (error) throw new Error(`Error en Supabase: ${error.message}`);
  return data;
}

// ── Handler principal de Vercel ───────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).json({ ok: true, message: "Triana Bot activo." });
  }

  res.status(200).json({ ok: true });

  const update = req.body;
  if (!update?.message?.text) return;

  const { message } = update;
  const chatId = message.chat.id;
  const userId = message.from.id;
  const texto = message.text.trim();
  const nombreUsuario = message.from.first_name || "Entrenador";

  try {
    if (texto === "/start") {
      await sendTelegramMessage(
        chatId,
        `👋 Hola <b>${nombreUsuario}</b>, soy el asistente del <b>Club Triana BM Vivero</b>.\n\n` +
        `Usa <code>/sesion [descripción]</code> para registrar.`
      );
      return;
    }

    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();

      if (!descripcion || descripcion.length < 10) {
        await sendTelegramMessage(chatId, `⚠️ <b>Descripción muy corta.</b>`);
        return;
      }

      await sendTelegramMessage(chatId, `⏳ <i>Analizando la sesión... un momento.</i>`);

      // 1. Procesar con Gemini
      const geminiData = await procesarSesionConGemini(descripcion);

      // 2. Guardar en Supabase
      const sesionGuardada = await guardarSesionEnSupabase(chatId, userId, descripcion, geminiData);

      // 3. Construir respuesta escapando el contenido de la IA (Mejora 1 aplicada aquí)
      // 3. Construir respuesta (Asegúrate de que esta parte esté así)
      const contenidosLimpios = escapeHTML(geminiData.contents);
      const objetivosFormateados = geminiData.objectives
        .map((obj, i) => `    ${i + 1}. ${escapeHTML(obj)}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `✅ <b>Sesión #${sesionGuardada.id} registrada</b>\n\n` +
        `<b>📝 Contenido técnico:</b>\n${contenidosLimpios}\n\n` +
        `<b>🎯 Objetivos:</b>\n${objetivosFormateados}`
      );
      return;
    }

  } catch (error) {
    console.error("Error en el handler:", error);
    await sendTelegramMessage(chatId, `❌ <b>Error al procesar.</b> Inténtalo de nuevo.`);
  }
}
