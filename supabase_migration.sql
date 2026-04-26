// api/webhook.js
import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function enviarMensaje(chatId, texto) {
  try {
    await axios.post(
      `${TELEGRAM_API}/sendMessage`,
      { chat_id: chatId, text: texto },
      { timeout: 20000 }  // ← subido a 20s
    );
  } catch (e) {
    console.error("Error enviando a Telegram:", e.message);
  }
}

export default async function handler(req, res) {
  res.status(200).json({ ok: true });

  if (req.method !== "POST" || !req.body?.message?.text) return;

  const chatId = req.body.message.chat.id;
  const userId = String(req.body.message.from.id);
  const texto = req.body.message.text.trim();

  try {
    if (texto === "/start") {
      await enviarMensaje(chatId, "Bot activo. Usa /sesion seguido de tu explicacion.");
      return;
    }

    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();

      if (descripcion.length < 10) {
        await enviarMensaje(chatId, "Descripcion muy corta. Escribe al menos 10 caracteres describiendo el entrenamiento.");
        return;
      }

      await enviarMensaje(chatId, "Procesando y guardando...");

      // Gemini con timeout de 20s
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Analiza este entrenamiento de balonmano y responde SOLO con un JSON valido (sin markdown, sin explicaciones): {"contents": "resumen breve", "objectives": ["objetivo1", "objetivo2"]}. Texto: ${descripcion}`;

      const geminiResult = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout Gemini")), 20000)  // ← subido a 20s
        )
      ]);

      const rawText = geminiResult.response
        .text()
        .replace(/```json|```/g, "")
        .trim();

      let geminiData;
      try {
        geminiData = JSON.parse(rawText);
      } catch {
        throw new Error("JSON invalido de Gemini: " + rawText.substring(0, 80));
      }

      if (!geminiData.contents || !Array.isArray(geminiData.objectives)) {
        throw new Error("Estructura incorrecta: " + JSON.stringify(geminiData).substring(0, 80));
      }

      // Lookup acceso (opcional)
      const { data: acceso } = await supabase
        .from("telegram_accesos")
        .select("socio_id")
        .eq("telegram_user_id", userId)
        .maybeSingle();

      // Insert en Supabase
      const { data: sesion, error: dbError } = await supabase
        .from("sesiones")
        .insert({
          fecha: new Date().toISOString(),
          contenido: descripcion,
          autor: userId,
          resumen_ia: geminiData.contents,
          entrenador_id: acceso?.socio_id || null,
          telegram_chat_id: String(chatId),
          telegram_user_id: userId,
        })
        .select()
        .single();

      if (dbError) throw new Error("DB: " + dbError.message);

      const respuesta =
        `✅ SESION GUARDADA (ID: ${sesion.id})\n\n` +
        `📋 CONTENIDO:\n${geminiData.contents}\n\n` +
        `🎯 OBJETIVOS:\n- ${geminiData.objectives.join("\n- ")}`;

      await enviarMensaje(chatId, respuesta);
    }
  } catch (error) {
    console.error("Error critico:", error.message);
    await enviarMensaje(chatId, "Error: " + error.message.substring(0, 150));
  }
}
