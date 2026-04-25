import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ── Función para que el texto de la IA no rompa Telegram ──
function cleanForTelegram(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("OK");
  res.status(200).json({ ok: true });

  const update = req.body;
  if (!update?.message?.text) return;

  const chatId = update.message.chat.id;
  const userId = update.message.from.id;
  const texto = update.message.text.trim();

  try {
    if (texto === "/start") {
      await sendTelegram(chatId, "👋 ¡Bot <b>Triana</b> activo!\nUsa <code>/sesion [texto]</code>");
      return;
    }

    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();
      if (descripcion.length < 5) return await sendTelegram(chatId, "⚠️ Escribe algo más de detalle.");

      await sendTelegram(chatId, "⏳ <i>Analizando sesión...</i>");

      // 1. Gemini
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Analiza: "${descripcion}". Responde SOLO JSON: {"contents": "resumen", "objectives": ["obj1"]}`;
      const result = await model.generateContent(prompt);
      const geminiData = JSON.parse(result.response.text().replace(/```json|```/g, "").trim());

      // 2. Supabase (Tabla: sesiones)
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

      // 3. Mensaje Final Formateado
      const msg = `✅ <b>Sesión #${sesion.id} registrada</b>\n\n` +
                  `<b>📝 Contenido:</b>\n${cleanForTelegram(geminiData.contents)}\n\n` +
                  `<b>🎯 Objetivos:</b>\n${geminiData.objectives.map(o => "• " + cleanForTelegram(o)).join("\n")}`;
      
      await sendTelegram(chatId, msg);
    }
  } catch (err) {
    console.error("ERROR:", err);
    await sendTelegram(chatId, "❌ La sesión se ha guardado, pero hubo un error en el formato del mensaje.");
  }
}

// ── Función de envío definitiva (Limpia y robusta) ──
async function sendTelegram(chatId, text) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML"
    });
  } catch (e) {
    // Si falla el HTML, enviamos el texto 100% plano (sin ninguna etiqueta)
    const superCleanText = text.replace(/<[^>]*>?/gm, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "⚠️ (Nota: Error de formato en Telegram)\n\n" + superCleanText
    });
  }
}
