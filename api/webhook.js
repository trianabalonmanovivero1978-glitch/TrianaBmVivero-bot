import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export default async function handler(req, res) {
  // 1. Respuesta inmediata para que Telegram no reintente
  res.status(200).send("ok");

  if (req.method !== "POST" || !req.body?.message?.text) return;

  const chatId = req.body.message.chat.id;
  const userId = req.body.message.from.id;
  const texto = req.body.message.text.trim();

  try {
    // Comando /start
    if (texto === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Bot activo. Usa /sesion seguido de la explicacion de tu entrenamiento."
      });
      return;
    }

    // Comando /sesion
    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();
      
      if (descripcion.length < 5) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "Descripcion demasiado corta." });
        return;
      }

      // Notificar que estamos trabajando
      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "Procesando sesion..." });

      // 2. IA: Gemini (Respuesta simple)
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Analiza este entrenamiento de balonmano y devuelve UNICAMENTE un objeto JSON con estas claves: contents (string con resumen) y objectives (array de strings con 2 o 3 objetivos). Texto: ${descripcion}`;
      
      const result = await model.generateContent(prompt);
      const cleanJson = result.response.text().replace(/```json|```/g, "").trim();
      const geminiData = JSON.parse(cleanJson);

      // 3. Base de Datos: Supabase (Sin riesgo de socio_id)
      const { data: acceso } = await supabase
        .from("telegram_accesos")
        .select("socio_id")
        .eq("telegram_user_id", String(userId))
        .maybeSingle(); // Si no estas en la tabla, no explota

      const { data: sesion, error: dbError } = await supabase
        .from("sesiones")
        .insert({
          entrenador_id: acceso ? acceso.socio_id : null,
          telegram_chat_id: String(chatId),
          telegram_user_id: String(userId),
          descripcion_original: descripcion,
          contents: geminiData.contents,
          objectives: geminiData.objectives
        })
        .select().single();

      if (dbError) throw dbError;

      // 4. Respuesta final (Texto plano, cero errores de formato)
      const mensajeFinal = 
        `SESION GUARDADA (ID: ${sesion.id})\n\n` +
        `RESUMEN: ${geminiData.contents}\n\n` +
        `OBJETIVOS:\n- ${geminiData.objectives.join("\n- ")}`;

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: mensajeFinal
      });
    }
  } catch (error) {
    console.error("Error critico:", error);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "Error al procesar. Revisa los logs en Vercel."
    });
  }
}
