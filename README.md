# Triana Digital Core — Bot Vercel

Bot de Telegram para el Club BM Triana Vivero. Registra sesiones de entrenamiento en Supabase usando Gemini 1.5 Flash como motor de extracción de contenido.

---

## Estructura del proyecto

```
triana-bot/
├── api/
│   └── webhook.js          ← Serverless Function principal
├── package.json
├── vercel.json
├── supabase_migration.sql  ← Ejecutar en Supabase antes del despliegue
└── README.md
```

---

## Variables de Entorno (Vercel)

| Variable                    | Dónde obtenerla                          |
|-----------------------------|------------------------------------------|
| `TELEGRAM_BOT_TOKEN`        | @BotFather en Telegram → /token          |
| `GEMINI_API_KEY`            | aistudio.google.com/app/apikey           |
| `SUPABASE_URL`              | Supabase → Project Settings → API        |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → service_role |

⚠️ NUNCA uses la `anon key` para el bot. El bot necesita la `service_role key` para escribir en la DB ignorando RLS.

---

## Despliegue paso a paso

### PASO 1 — Preparar Supabase
1. Abre tu proyecto en [supabase.com](https://supabase.com)
2. Ve a **SQL Editor**
3. Copia y pega el contenido de `supabase_migration.sql` y ejecútalo
4. Verifica que la tabla `training_sessions` aparece en **Table Editor**

### PASO 2 — Preparar el repositorio en GitHub
```bash
# En tu máquina local, crea la carpeta del proyecto
mkdir triana-bot && cd triana-bot

# Copia los archivos:
# - api/webhook.js
# - package.json
# - vercel.json

# Inicia git y sube a GitHub
git init
git add .
git commit -m "feat: Triana Digital Core Bot v1.0"
git remote add origin https://github.com/TU_USUARIO/triana-bot.git
git push -u origin main
```

### PASO 3 — Crear el proyecto en Vercel
1. Ve a [vercel.com](https://vercel.com) → **Add New Project**
2. Importa tu repositorio de GitHub `triana-bot`
3. Framework Preset: **Other**
4. Root Directory: dejar vacío (raíz del repo)
5. Haz clic en **Deploy** (fallará sin las env vars, es normal)

### PASO 4 — Configurar Variables de Entorno
1. En Vercel → tu proyecto → **Settings → Environment Variables**
2. Añade las 4 variables:

```
TELEGRAM_BOT_TOKEN       = (tu nuevo token de @BotFather)
GEMINI_API_KEY           = (tu nueva API key de Google AI Studio)
SUPABASE_URL             = https://xxxxxxxxxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

3. Marca las 4 variables para los entornos: **Production**, **Preview**, **Development**
4. Haz clic en **Save**

### PASO 5 — Redesplegar
1. Ve a **Deployments** en Vercel
2. En el último deployment → **⋯ → Redeploy**
3. Espera ~30 segundos a que termine
4. Anota tu URL de producción: `https://triana-bot.vercel.app`

### PASO 6 — Registrar el Webhook en Telegram
Ejecuta este comando en tu terminal (sustituye los valores):

```bash
curl -X POST "https://api.telegram.org/bot<TU_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://triana-bot.vercel.app/api/webhook",
    "allowed_updates": ["message"],
    "drop_pending_updates": true
  }'
```

Respuesta esperada:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### PASO 7 — Verificar que todo funciona
1. Abre Telegram → busca tu bot → envía `/start`
2. El bot debe responder con el mensaje de bienvenida
3. Prueba un registro real:
```
/sesion Hoy hemos trabajado defensa 6:0 con basculaciones y transición al ataque posicional. Duración 75 minutos. Participaron 14 jugadores.
```
4. Verifica en **Supabase → Table Editor → training_sessions** que el registro aparece

---

## Verificar el estado del Webhook

```bash
curl "https://api.telegram.org/bot<TU_TOKEN>/getWebhookInfo"
```

---

## Comandos del bot

| Comando | Función |
|---------|---------|
| `/start` | Mensaje de bienvenida y lista de comandos |
| `/ayuda` | Instrucciones de uso |
| `/sesion [descripción]` | Registra una sesión de entrenamiento |
