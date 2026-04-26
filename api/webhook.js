import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// Funcion UNICA para enviar mensajes (sin HTML para evitar errores)
async function enviarMensaje(chatId, texto) {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: texto
    });
  } catch (e) {
    console.error("Error enviando a Telegram:", e.message);
  }
}

export default async function handler(req, res) {
  res.status(200).send("ok");
  if (req.method !== "POST" || !req.body?.message?.text) return;

  const chatId = req.body.message.chat.id;
  const userId = req.body.message.from.id;
  const texto = req.body.message.text.trim();

  try {
    if (texto === "/start") {
      await enviarMensaje(chatId, "Bot activo. Usa /sesion seguido de tu explicacion.");
      return;
    }

    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();
      if (descripcion.length < 5) {
        await enviarMensaje(chatId, "Descripcion muy corta.");
        return;
      }

      await enviarMensaje(chatId, "Procesando...");

      // 1. IA
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Analiza este entrenamiento de balonmano y responde SOLO con un JSON (sin markdown): {"contents": "resumen", "objectives": ["obj1", "obj2"]}. Texto: ${descripcion}`;
      
      const result = await model.generateContent(prompt);
      const rawText = result.response.text().replace(/```json|```/g, "").trim();
      const geminiData = JSON.parse(rawText);

      // 2. Base de Datos
      const { data: acceso } = await supabase
        .from("telegram_accesos")
        .select("socio_id")
        .eq("telegram_user_id", String(userId))
        .maybeSingle();

      const { data: sesion, error: dbError } = await supabase
        .from("sesiones")
        .insert({
          entrenador_id: acceso?.socio_id || null,
          telegram_chat_id: String(chatId),
          telegram_user_id: String(userId),
          descripcion_original: descripcion,
          contents: geminiData.contents,
          objectives: geminiData.objectives
        })
        .select().single();

      if (dbError) throw dbError;

      // 3. Respuesta Final
      const respuesta = "SESION GUARDADA (ID: " + sesion.id + ")\n\n" +
                        "CONTENIDO: " + geminiData.contents + "\n\n" +
                        "OBJETIVOS:\n- " + geminiData.objectives.join("\n- ");

      await enviarMensaje(chatId, respuesta);
    }
  } catch (error) {
    console.error("Error final:", error);
    await enviarMensaje(chatId, "Error al procesar. Revisa que el texto sea claro.");
  }
}
