// ============================================================
// TRIANA DIGITAL CORE — Bot Webhook (Versión 100% Robusta)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

// ── Inicialización de Clientes ───────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ── Función auxiliar: Limpiar texto para evitar errores de Telegram ──────────
function cleanForTelegram(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Función auxiliar: Enviar mensaje con sistema de rescate ───────────────────
async function sendTelegramMessage(chatId, text) {
  try {
    // Intento 1: Enviar con formato HTML
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    });
  } catch (error) {
    console.error("Fallo HTML, enviando texto plano...");
    // Intento 2: Si falla el HTML, enviamos el texto 100% limpio de etiquetas
    try {
      const plainText = text
        .replace(/<[^>]*>?/gm, '') // Borra etiquetas <b>, <i>, etc.
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
        
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: "⚠️ (Nota: Ajuste de formato automático)\n\n" + plainText,
      });
    } catch (retryError) {
      console.error("Error crítico en Telegram:", retryError.message);
    }
  }
}

// ── Función auxiliar: Procesar descripción con Gemini ────────────────────────
async function procesarSesionConGemini(descripcion) {
  const model = genAI.getGenerativeModel({
    model: "gemini-1.5-flash",
    generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    systemInstruction: `Eres un experto en balonmano. Analiza la sesión y extrae contenido técnico. 
    Responde ÚNICAMENTE con un JSON: {"contents": "string", "objectives": ["string"]}`,
  });

  const result = await model.generateContent(descripcion);
  const responseText = result.response.text().replace(/```json|```/g, "").trim();
  return JSON.parse(responseText);
}

// ── Función auxiliar: Guardar en Supabase (Blindada contra errores de acceso) ─
async function guardarSesionEnSupabase(chatId, userId, descripcion, geminiData) {
  // Buscamos si el usuario de Telegram tiene permiso (entrenador registrado)
  const { data: acceso } = await supabase
    .from("telegram_accesos")
    .select("socio_id")
    .eq("telegram_user_id", String(userId))
    .eq("activo", true)
    .maybeSingle(); // No da error si no encuentra nada

  const entrenadorId = acceso ? acceso.socio_id : null;

  // Insertamos en la tabla "sesiones"
  const { data, error } = await supabase
    .from("sesiones")
    .insert({
      entrenador_id: entrenadorId,
      telegram_chat_id: String(chatId),
      telegram_user_id: String(userId),
      descripcion_original: descripcion,
      contents: geminiData.contents,
      objectives: geminiData.objectives
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

// ── Handler Principal de Vercel ───────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("Bot Triana Online");
  
  // Responder 200 a Telegram de inmediato
  res.status(200).json({ ok: true });

  const update = req.body;
  if (!update?.message?.text) return;

  const chatId = update.message.chat.id;
  const userId = update.message.from.id;
  const texto = update.message.text.trim();
  const nombreUsuario = update.message.from.first_name || "Entrenador";

  try {
    // Comando /start
    if (texto === "/start") {
      await sendTelegramMessage(chatId, `👋 ¡Hola <b>${nombreUsuario}</b>!\nUsa <code>/sesion [descripcion]</code> para registrar tu entrenamiento.`);
      return;
    }

    // Comando /sesion
    if (texto.startsWith("/sesion")) {
      const descripcion = texto.replace("/sesion", "").trim();
      
      if (descripcion.length < 10) {
        await sendTelegramMessage(chatId, "⚠️ La descripción es muy corta. Detalla un poco más el entrenamiento.");
        return;
      }

      await sendTelegramMessage(chatId, "⏳ <i>Analizando con IA y guardando en el panel del DT...</i>");

      // 1. Procesar con Gemini
      const geminiData = await procesarSesionConGemini(descripcion);

      // 2. Guardar en Supabase
      const sesion = await guardarSesionEnSupabase(chatId, userId, descripcion, geminiData);

      // 3. Formatear y enviar respuesta final
      const contenidosLimpios = cleanForTelegram(geminiData.contents);
      const objetivosLimpios = geminiData.
