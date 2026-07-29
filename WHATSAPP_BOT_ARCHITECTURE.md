# Guía técnica: Bot de WhatsApp con IA (Meta Cloud API + Supabase Edge Function + OpenAI)

> Este documento describe la arquitectura **real y actual** de `supabase/functions/whatsapp-webhook/index.ts`
> para poder replicarla en otro proyecto. Los archivos `META_APP_SETUP.md`, `WHATSAPP_PHASE2_SETUP.md` y
> `supabase/functions/whatsapp-webhook/README.md` quedaron desactualizados: mencionan "Fase 1/echo" y
> "Claude/Gemini", pero el código en producción usa **OpenAI (`gpt-4o-mini` + Whisper)** con *function calling*.
> Úsalos solo para la parte de configuración en el panel de Meta (sigue siendo válida); para la arquitectura
> de código, usa este documento.

---

## 1. Visión general del flujo

```
WhatsApp (usuario) ──▶ Meta Cloud API ──▶ Webhook (Supabase Edge Function)
                                                │
                                                ├─ 1. Verifica firma HMAC (X-Hub-Signature-256)
                                                ├─ 2. Resuelve rol del número (admin/viewer/unauthorized)
                                                ├─ 3. Marca mensaje como leído (read receipt)
                                                ├─ 4. Intercepta comandos rápidos (sin IA) — regex
                                                ├─ 5. Si no hay match, llama a OpenAI con "tools" (function calling)
                                                │      OpenAI decide qué función ejecutar (consulta/escritura en Supabase)
                                                ├─ 6. Guarda el turno (user + assistant) en whatsapp_chats
                                                └─ 7. Responde vía Meta Graph API (texto o lista interactiva)
```

Todo corre en **una sola Edge Function de Deno** (sin backend adicional). No hay servidor propio: Meta llama
directo al endpoint público de Supabase.

---

## 2. Piezas necesarias

| Pieza | Rol |
|---|---|
| **Meta for Developers app** (tipo Business + producto WhatsApp) | Origen de los mensajes, canal de envío |
| **Supabase Edge Function** (`whatsapp-webhook`) | Recibe el webhook, orquesta todo |
| **OpenAI API** (`gpt-4o-mini` para chat/tools, `whisper-1` para audio) | Cerebro conversacional + tool calling |
| **Tablas Supabase**: `whatsapp_chats`, `debug_logs`, + tablas de dominio (`animals`, `events` en este caso) | Historial de conversación, logs de diagnóstico, datos del negocio |
| **Frontend** (`WhatsAppModule.tsx`) | Visualiza conversaciones leyendo `whatsapp_chats` vía Supabase client |

---

## 3. Configuración en Meta (una sola vez por proyecto)

Sigue `META_APP_SETUP.md` tal cual — sigue siendo válido:

1. Crear app "Business" en https://developers.facebook.com
2. Agregar producto **WhatsApp** → modo **"Try it out"** para desarrollo
3. Anotar 4 valores:
   - `META_PHONE_NUMBER_ID`
   - `META_APP_SECRET` (Settings → Basic)
   - `META_VERIFY_TOKEN` (inventado por ti, string arbitrario)
   - `META_ACCESS_TOKEN` (temporal 24h al inicio; luego System User permanente)
4. Registrar el número de admin en formato E.164 sin `+` (ej. `5215512345678`)

En producción real conviene migrar de "Try it out" a un número de producción verificado y a un
**System User token permanente** (no expira cada 24h).

---

## 4. Variables de entorno (Supabase secrets)

```bash
supabase secrets set META_VERIFY_TOKEN="tu_token_arbitrario"
supabase secrets set META_APP_SECRET="<de Meta>"
supabase secrets set META_ACCESS_TOKEN="<de Meta>"
supabase secrets set META_PHONE_NUMBER_ID="<de Meta>"
supabase secrets set ADMIN_WHATSAPP_NUMBERS="5215512345678"       # coma-separado
supabase secrets set VIEWER_WHATSAPP_NUMBERS="5215500000000"      # opcional, coma-separado
supabase secrets set OPENAI_API_KEY="sk-..."
supabase secrets set SUPABASE_URL="https://<project>.supabase.co"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="<service_role_key>"
```

`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` suelen estar disponibles automáticamente dentro de una Edge
Function, pero el código los lee explícitamente de `Deno.env`, así que confirma que existan como secrets.

---

## 5. Esquema de base de datos mínimo

El código real usa `whatsapp_chats` (no `whatsapp_messages`, que es de una migración anterior sin usar
actualmente por el bot — solo el frontend viejo o pruebas la referencian). Ya existe la migración
`supabase/migrations/20260728_create_whatsapp_chats_and_debug_logs.sql` en este repo (usa `IF NOT EXISTS`,
así que es segura de correr aunque las tablas ya existieran manualmente). Al replicar en otro proyecto, copia
ese archivo tal cual:

```sql
create table if not exists whatsapp_chats (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_whatsapp_chats_phone_created
  on whatsapp_chats (phone_number, created_at desc);

alter table whatsapp_chats enable row level security;

create policy "service role manages whatsapp_chats"
  on whatsapp_chats for all using (auth.role() = 'service_role');

create policy "authenticated can read whatsapp_chats"
  on whatsapp_chats for select using (auth.role() = 'authenticated');
```

```sql
create table if not exists debug_logs (
  id uuid primary key default gen_random_uuid(),
  message text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

alter table debug_logs enable row level security;
create policy "service role manages debug_logs"
  on debug_logs for all using (auth.role() = 'service_role');
```

`debug_logs` es clave para depurar Meta (firmas inválidas, errores de envío, verificación del webhook) sin
depender solo de `supabase functions logs`.

---

## 6. Estructura del código (`index.ts`)

Organiza el archivo en estas secciones, en este orden (así está hoy):

1. **Constantes y clientes** — lee todos los `Deno.env.get(...)`, inicializa `supabase` (service role) y
   `openai` (lazy, se crea la primera vez que se usa).
2. **Roles** — `getUserRole(phone)` → `"admin" | "viewer" | "unauthorized"` comparando contra las listas de
   env vars. Todo mensaje de un número no autorizado se rechaza con un aviso y **no se procesa**.
3. **Seguridad Meta**:
   - `verifySignature(rawBody, header)` — valida `X-Hub-Signature-256` con HMAC-SHA256 sobre el `APP_SECRET`,
     comparación en tiempo constante.
   - Validación adicional en `extractMessages`: descarta cualquier `value.metadata.phone_number_id` que no
     coincida con `META_PHONE_NUMBER_ID` (evita procesar webhooks de otro número).
4. **Envío** — `sendWhatsAppMessage(to, text)` y `sendReadReceipt(messageId)` contra
   `https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages`.
5. **Extracción** — `extractMessages(body)` normaliza el payload de Meta (que trae `entry[].changes[].value`)
   a una lista plana de `{from, id, type, text, interactive, audio, image, senderName}`. Soporta `text`,
   `interactive`, `audio`, `image`; ignora otros tipos (`sticker`, `document`, etc. — agrégalos si los
   necesitas).
6. **Historial** — `getChatHistory` (TTL de 2h, últimos 20 mensajes), `saveChatMessage`,
   `isFirstMessageOfDay` (para inyectar un resumen de contexto solo en el primer mensaje del día).
7. **Herramientas de dominio** (las "tools" que OpenAI puede invocar) — en este proyecto son funciones sobre
   la tabla `animals`/`events`: `searchAnimals`, `getAnimalDetails`, `getAnimalById`, `getInventorySummary`,
   `getUpcomingAlerts`, `getEventReport`, y de escritura (solo admin, con `checkAdminPermission`):
   `updateAnimalWeight`, `updateAnimalIdentifiers`, `updateHealthStatus`, `updateReproductiveStatus`,
   `registerNewAnimal`, `registerDeathOrSale`, `registerBirth`. **Esta es la parte que cambia por completo al
   replicar en otro dominio** — reemplázalas por las entidades de tu propio proyecto.
8. **Comandos rápidos sin IA** — `interceptQuickCommand(text, isAdmin)`: regex para saludo, ayuda, cancelar,
   alertas, inventario, reporte de hoy, y búsqueda directa por un solo token (arete/nombre). Corre **antes**
   de llamar a OpenAI para ahorrar latencia y costo en las consultas más comunes.
9. **`processMessageWithOpenAI(userMessage, phoneNumber, senderName)`** — el núcleo:
   - Arma `systemPrompt` con fecha actual, contexto diario, rol del usuario y **reglas de formato para
     WhatsApp** (nada de markdown `#`, usar `*negrita*`, emojis en vez de viñetas — WhatsApp no renderiza
     markdown estándar).
   - Llama `openai.chat.completions.create({ model: "gpt-4o-mini", messages, tools })`.
   - Si `response.tool_calls` viene poblado, ejecuta cada función localmente, agrega el resultado como
     mensaje `role: "tool"` y vuelve a llamar a OpenAI hasta que responda con texto final (loop de tool use).
10. **`Deno.serve`** — el handler HTTP:
    - `GET` → verificación del webhook (`hub.mode`, `hub.verify_token`, `hub.challenge`).
    - `POST` → valida firma (⚠️ ver nota de seguridad abajo), extrae mensajes, por cada uno resuelve el rol,
      marca leído, guarda el mensaje del usuario, despacha según `type` (interactive/text/audio/image), y
      responde por Meta. Envuelto en try/catch con logging a `debug_logs` en cada etapa.
11. **Interactivos** — `sendWhatsAppInteractive` (Flows) y `sendWhatsAppMenu` (listas) para menús ricos en
    vez de solo texto.
12. **Media** — `transcribeAudio` (descarga de Meta Media API + Whisper) y `downloadMediaBase64` (para
    mandar imágenes a OpenAI Vision como `image_url` con data URI).

### ✅ Nota de seguridad (corregido 2026-07-28)

Antes, si `verifySignature` fallaba, solo se logueaba el error pero el mensaje se procesaba igual (el
`return new Response("unauthorized", 401)` estaba comentado). Ya se corrigió: ahora un payload con firma
inválida se rechaza con `401` antes de procesar nada. Si al desplegar empiezas a ver `401` inesperados,
revisa que `META_APP_SECRET` esté cargado correctamente en los secrets de Supabase — es la causa más común.

---

## 7. Deploy

```bash
supabase link --project-ref <tu-project-ref>
supabase secrets set ...   # todos los de la sección 4
supabase db push           # aplica migraciones (whatsapp_chats, debug_logs, etc.)
supabase functions deploy whatsapp-webhook --no-verify-jwt
```

`--no-verify-jwt` es obligatorio: Meta no manda JWT de Supabase, manda su propia firma HMAC.

URL resultante: `https://<project-ref>.supabase.co/functions/v1/whatsapp-webhook`

En Meta → **WhatsApp → Configuration → Webhook**: pega esa URL, pon el mismo `META_VERIFY_TOKEN`, click
**Verify and Save**, y suscríbete al campo **`messages`**.

---

## 8. Checklist para replicar en un proyecto nuevo

1. [ ] Crear app de Meta y obtener los 4 valores (sección 3)
2. [ ] Crear proyecto/branch de Supabase, copiar `supabase/functions/whatsapp-webhook/index.ts` como base
3. [ ] Copiar la migración `20260728_create_whatsapp_chats_and_debug_logs.sql` (sección 5)
4. [ ] Reemplazar las "tools" de dominio (sección 6, punto 7) por las entidades del nuevo proyecto
5. [ ] Ajustar el `systemPrompt` (reglas de formato, tono, nombre del asistente)
6. [ ] Cargar todos los secrets (sección 4)
7. [ ] `supabase db push` + `supabase functions deploy whatsapp-webhook --no-verify-jwt`
8. [ ] Registrar webhook en Meta y suscribir `messages`
9. [ ] Probar: mensaje de saludo, comando rápido (`ayuda`), búsqueda con tool calling, nota de voz, imagen
10. [ ] (Opcional) construir un módulo de frontend tipo `WhatsAppModule.tsx` que lea `whatsapp_chats`
    agrupado por `phone_number` para visualizar conversaciones desde el dashboard
11. [ ] Migrar `META_ACCESS_TOKEN` temporal a un System User token permanente antes de producción real

---

## 9. Referencia de archivos en este repo

| Archivo | Contenido |
|---|---|
| `supabase/functions/whatsapp-webhook/index.ts` | Toda la lógica del bot (fuente de verdad) |
| `supabase/functions/whatsapp-webhook/README.md` | Guía original de Fase 1 (echo) — histórica, no refleja el código actual |
| `META_APP_SETUP.md` | Paso a paso de configuración en el panel de Meta — sigue vigente |
| `WHATSAPP_PHASE2_SETUP.md` | Guía de deploy de Fase 2 — vigente en los comandos de deploy, desactualizada en "Claude" (ahora es OpenAI) |
| `TEST_WHATSAPP_BOT.md` | Plan de pruebas manual muy completo — vigente, aunque menciona "Gemini" donde debería decir "OpenAI" |
| `src/pages/WhatsAppModule.tsx` | Módulo de frontend que lista conversaciones desde `whatsapp_chats` |
| `supabase/migrations/20260422_create_whatsapp_messages.sql` | Migración de una tabla (`whatsapp_messages`) que el bot actual ya no usa — no la repliques, usa `whatsapp_chats` |
