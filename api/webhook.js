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
async function sendTelegramMessage(chatId, text) {
  try {
    // Intentamos enviar con HTML
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Fallo HTML, enviando como texto plano limpio...");
    // Si falla, enviamos el texto eliminando manualmente las etiquetas HTML que pusimos
    const plainText = text.replace(/<[^>]*>?/gm, ''); 
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: plainText,
    });
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

     // Aquí aplicamos la limpieza para que Telegram no se rompa
      const contenidosLimpios = escapeHTML(geminiData.contents);
      const objetivosLimpios = geminiData.objectives
        .map((obj, i) => `    ${i + 1}. ${escapeHTML(obj)}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `✅ <b>Sesión #${sesion.id} registrada</b>\n\n` +
        `<b>📝 Contenido:</b>\n${contenidosLimpios}\n\n` +
        `<b>🎯 Objetivos:</b>\n${objetivosLimpios}`
      );
    }
  } catch (error) {
    console.error("ERROR FINAL:", error);
    await sendTelegramMessage(chatId, "❌ Hubo un error. La sesión podría haberse guardado, pero falló la respuesta.");
  }
}
      // 1. Llamada a Gemini mejorada
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Analiza esta sesión de balonmano: "${descripcion}". 
      Responde SOLO con este JSON: {"contents": "resumen técnico", "objectives": ["obj1", "obj2"]}`;
      
      const result = await model.generateContent(prompt);
      const responseText = result.response.text().replace(/```json|```/g, "").trim();
      const geminiData = JSON.parse(responseText);

      // 2. Guardar en Supabase (Solo campos seguros para evitar errores de tipo UUID)
      const { data: sesion, error: dbError } = await supabase
        .from("sesiones")
        .insert({
          telegram_chat_id: String(chatId),
          descripcion_original: descripcion,
          contents: geminiData.contents,
          objectives: geminiData.objectives
        })
        .select().single();

      if (dbError) throw dbError;

      // 3. Respuesta final
      const msg = `✅ <b>Sesión #${sesion.id} guardada</b>\n\n` +
                  `<b>📝 Contenido:</b> ${escapeHTML(geminiData.contents)}\n` +
                  `<b>🎯 Objetivos:</b>\n${geminiData.objectives.map(o => "• " + escapeHTML(o)).join("\n")}`;
      
      await sendTelegram(chatId, msg);
    }
  } catch (err) {
    console.error("ERROR:", err);
    await sendTelegram(chatId, "❌ Error técnico. La IA o la Base de Datos no han respondido bien.");
  }
}

// ── Función de envío ultra-segura ──
async function sendTelegram(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML"
    });
  } catch (e) {
    const cleanText = text.replace(/<[^>]*>?/gm, '');
    await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: cleanText });
  }
}   - "objectives": array de strings, cada uno representando un objetivo metodológico concreto.
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
async function sendTelegramMessage(chatId, text) {
  try {
    // Intentamos enviar con HTML
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Fallo HTML, enviando como texto plano limpio...");
    // Si falla, enviamos el texto eliminando manualmente las etiquetas HTML que pusimos
    const plainText = text.replace(/<[^>]*>?/gm, ''); 
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: plainText,
    });
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

     // Aquí aplicamos la limpieza para que Telegram no se rompa
      const contenidosLimpios = escapeHTML(geminiData.contents);
      const objetivosLimpios = geminiData.objectives
        .map((obj, i) => `    ${i + 1}. ${escapeHTML(obj)}`)
        .join("\n");

      await sendTelegramMessage(
        chatId,
        `✅ <b>Sesión #${sesion.id} registrada</b>\n\n` +
        `<b>📝 Contenido:</b>\n${contenidosLimpios}\n\n` +
        `<b>🎯 Objetivos:</b>\n${objetivosLimpios}`
      );
    }
  } catch (error) {
    console.error("ERROR FINAL:", error);
    await sendTelegramMessage(chatId, "❌ Hubo un error. La sesión podría haberse guardado, pero falló la respuesta.");
  }
}
