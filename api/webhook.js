import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

export default async function handler(req, res) {
  // Respuesta rápida para Telegram
  res.status(200).send("ok");

  if (req.method !== "POST" || !req.body?.message?.text) return;

  const chatId = req.body.message.chat.id;
  const userId = req.body.message.from.id;
  const texto = req.body.message.text.trim();

  try {
    if (texto === "/start") {
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "Bot de Triana activo. Usa /sesion seguido de tu explicacion."
      });
      return;
    }

    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();
      if (descripcion.length < 5) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "Escribe mas detalles de la sesion." });
        return;
      }

      await axios.post(`${TELEGRAM_API}/sendMessage`, { chat_id: chatId, text: "Procesando y guardando..." });

      // 1. Llamada a Gemini (Flash)
      const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      const prompt = `Analiza este entrenamiento de balonmano y responde SOLO con un JSON: {"contents": "resumen tecnico", "objectives": ["obj1", "obj2"]}. Texto: ${descripcion}`;
      
      const result = await model.generateContent(prompt);
      const responseText = result.response.text().replace(/```json|```/g, "").trim();
      
      if (!responseText) throw new Error("Gemini no respondio");
      const geminiData = JSON.parse(responseText);

      // 2. Busqueda de usuario (Blindada contra errores de socio_id)
      const { data: acceso } = await supabase
        .from("telegram_accesos")
        .select("socio_id")
        .eq("telegram_user_id", String(userId))
        .maybeSingle();

      const idParaGuardar = acceso?.socio_id || null;

      // 3. Insertar en Supabase (Tabla: sesiones)
      const { data: sesion, error: dbError } = await supabase
        .from("sesiones")
        .insert({
          entrenador_id: idParaGuardar,
          telegram_chat_id: String(chatId),
          telegram_user_id: String(userId),
          descripcion_original: descripcion,
          contents: geminiData.contents,
          objectives: geminiData.objectives
        })
        .select().single();

      if (dbError) throw dbError;

      // 4. Respuesta final (TEXTO PLANO, SIN FORMATO QUE DE ERROR)
      const mensajeFinal = 
        "SESION REGISTRADA CON EXITO (ID: " + sesion.id + ")\n\n" +
        "RESUMEN: " + geminiData.contents + "\n\n" +
        "OBJETIVOS:\n- " + geminiData.objectives.join("\n- ");

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: mensajeFinal
      });
    }
  } catch (error) {
    console.error("Error final:", error);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "Error al procesar la sesion. Intentalo de nuevo en unos segundos."
    });
  }
}
