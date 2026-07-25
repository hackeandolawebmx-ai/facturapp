# FacturasMX — Fase 3b

Plataforma que consolida y valida facturas mexicanas (**CFDI 4.0**) para
deducciones anuales. **Fase 2a** convirtió el MVP en un producto multiusuario
(Supabase + JWT + chat con OpenAI); **Fase 2b** endureció la seguridad (rate
limiting, refresh tokens, RFC estricto, manejo de errores de OpenAI, logging);
**Fase 3a** agregó ingesta por **correo** (SendGrid); **Fase 3b** agrega
ingesta por **WhatsApp** (Meta Cloud API) — reenviar la factura al número de
negocio y recibir la respuesta ahí mismo.

El **parser, validador y clasificador de Fase 1 no cambiaron** — solo se
agregaron capas de auth, persistencia real, chat, seguridad e ingesta por
correo/WhatsApp encima.

---

## Requisitos

- Python 3.12+ (probado en 3.14)
- Cuenta Supabase (Postgres) para producción
- API key de OpenAI para el chat
- Ver `requirements.txt`

## Instalación

```bash
python -m venv .venv
# Windows
.venv\Scripts\activate
# Linux / macOS
source .venv/bin/activate
pip install -r facturapp/requirements.txt
```

Copia `facturapp/.env.example` a `.env` en la raíz del proyecto y complétalo:

```
DATABASE_URL=postgresql://postgres:PASSWORD@db.xxxxx.supabase.co:5432/postgres
SECRET_KEY=<clave-larga-secreta-min-32-chars>
ACCESS_TOKEN_EXPIRE_MINUTES=60
REFRESH_TOKEN_EXPIRE_DAYS=7
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o

# WhatsApp (Meta Cloud API) — ver sección "Ingesta por WhatsApp" abajo
WHATSAPP_TOKEN=<access token de Graph API>
WHATSAPP_VERIFY_TOKEN=<string que tú inventas, para el handshake GET>
WHATSAPP_APP_SECRET=<App Secret de tu app de Meta — NO es el verify token>
WHATSAPP_PHONE_NUMBER_ID=<Phone Number ID del número de WhatsApp Business>
```

> ⚠️ Si tu `.env` viene de Fase 2a, probablemente tenga
> `ACCESS_TOKEN_EXPIRE_MINUTES=1440` (24 h) — actualízalo a `60` (1 h) para
> que aplique el endurecimiento de Fase 2b. `pydantic-settings` da prioridad
> al valor del `.env` sobre el default del código.

> Sin `DATABASE_URL` la app usa SQLite local (`./facturapp.db`). Útil para
> desarrollo; para producción/multiusuario usa Supabase.

## Migrar el esquema a Supabase

```bash
python scripts/migrate_to_supabase.py          # crea tablas
python scripts/migrate_to_supabase.py --seed    # + 2 usuarios de prueba
```

Crea `users`, `invoices` y `chat_messages`. Con `--seed`, dos usuarios con
contraseña `password123`.

## Correr los tests

```bash
pytest facturapp/tests -v
```

**91 tests en verde** (41 de Fase 2a + 21 de Fase 2b + 10 de Fase 3a + 19 de
Fase 3b). Corren offline: BD SQLite en-memory, el LLM mockeado, el rate
limiter reseteado por test, y las llamadas a la Graph API de Meta mockeadas
(no gastan API de OpenAI ni tocan Supabase, SendGrid o Meta).

## Iniciar la aplicación

```bash
uvicorn facturapp.main:app --reload
```

- Docs interactivas: http://127.0.0.1:8000/docs
- Dashboard web: http://127.0.0.1:8000/a/{web_token}

---

## Flujo de uso

```bash
# 1. Registro
curl -X POST localhost:8000/auth/register -H "Content-Type: application/json" \
  -d '{"email":"tu@correo.com","nombre":"Tu Nombre","rfc":"DAXX860715XX0","password":"password123"}'

# 2. Login → JWT
TOKEN=$(curl -s -X POST localhost:8000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"tu@correo.com","password":"password123"}' | jq -r .access_token)

# 3. Ingesta (requiere Bearer)
curl -X POST localhost:8000/webhooks/email -H "Authorization: Bearer $TOKEN" \
  -F "file=@facturapp/seeds/cfdi-valido.xml"

# 4. Resumen (solo tus datos)
curl "localhost:8000/api/summary?year=2026" -H "Authorization: Bearer $TOKEN"

# 5. Chat conversacional
curl -X POST localhost:8000/api/chat -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{"message":"¿cuánto llevo en médicos?"}'
```

## Endpoints

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| POST | `/auth/register` | — | Registro (email, nombre, RFC exacto de 13 chars, password) |
| POST | `/auth/login` | — | Login → access_token (1 h) + refresh_token (7 d). Máx 5/min por IP. |
| POST | `/auth/refresh` | Bearer (refresh) | Cambia un refresh_token por un access_token nuevo |
| GET | `/api/user/profile` | Bearer | Perfil del usuario |
| POST | `/webhooks/email` | Bearer | Ingesta CFDI/PDF manual (usuario ya autenticado) |
| POST | `/webhooks/sendgrid` | — (público) | Ingesta CFDI/PDF vía correo reenviado (SendGrid) |
| GET | `/webhooks/whatsapp` | — (público) | Handshake de verificación del webhook (Meta) |
| POST | `/webhooks/whatsapp` | — (público, firma HMAC) | Ingesta CFDI/PDF vía WhatsApp (Meta Cloud API) |
| GET | `/api/summary` | Bearer | Cédula por categoría (solo tus datos) |
| GET | `/api/invoices` | Bearer | Lista de facturas (solo tuyas) |
| POST | `/api/invoices/{id}/reclassify` | Bearer | Reclasificar factura |
| POST | `/api/chat` | Bearer | Chat conversacional (OpenAI) |
| GET | `/a/{token}` | web_token | Dashboard HTML |
| GET | `/api/public/{summary,invoices}` | web_token | Datos para el dashboard |

Todos los endpoints `/api/*` (salvo `/api/public/*`) requieren
`Authorization: Bearer <jwt>` y filtran por `user_id` (zero-trust).

## Chat: 5 intenciones + function calling

`chat.py` usa el **SDK de OpenAI** con function calling. Herramientas:

| Herramienta | Qué hace |
|-------------|----------|
| `get_summary` | Totales de deducción por categoría |
| `list_invoices` | Lista con filtros (año, mes, categoría) |
| `reclassify_invoice` | Reclasifica una factura |
| `export_package` | Genera ZIP (mock, Fase 4) |
| `explain_deductions` | Explica categorías deducibles |

Cada herramienta consulta la BD **filtrando por `user.id`**. El modelo es
configurable con `OPENAI_MODEL` (default `gpt-4o`).

## Ingesta por correo (Fase 3a)

Flujo: usuario reenvía su factura a `daniel@facturapp.mx` → SendGrid Inbound
Parse → `POST /webhooks/sendgrid` → parser/validator/classifier (los mismos
de Fase 1) → se guarda en `invoices`.

- **Resolución de usuario por remitente** ([email_service.py](email_service.py)):
  si el correo del remitente ya está registrado, se usa esa cuenta; si no,
  se crea una **cuenta mínima** (RFC placeholder `PEND` + hash, contraseña
  aleatoria inutilizable — no permite login directo). El usuario completa su
  perfil real después. Extrae la dirección de formatos `"Nombre" <correo>`.
- **Adjuntos**: JSON con `attachments: [{filename, content: base64}]`, se
  clasifican por extensión (`.xml` / `.pdf`); si no hay ninguno reconocido,
  responde `202` con `estatus: "sin_adjuntos"`.
- **Distinto de `/webhooks/email`**: ese endpoint sigue siendo Bearer +
  multipart, para cuando el propio usuario autenticado sube un archivo desde
  el dashboard. `/webhooks/sendgrid` es público (SendGrid no puede mandar tu
  JWT) y recibe JSON, no multipart.

> ⚠️ **Pendiente de producción:** `/webhooks/sendgrid` no verifica que la
> petición venga realmente de SendGrid (sin firma ni allowlist de IP) — en
> teoría cualquiera que sepa el email de un usuario podría asociarle una
> factura falsa. Antes de exponerlo públicamente, agregar verificación de
> IP de SendGrid o un secreto compartido en la URL del webhook.
>
> ⚠️ **SendGrid Inbound Parse real envía `multipart/form-data`**, no JSON.
> Este endpoint asume un adaptador/relay que normaliza el correo a la forma
> JSON documentada arriba antes de reenviarlo aquí — no está cableado
> directamente al webhook crudo de SendGrid todavía.

## Ingesta por WhatsApp (Fase 3b)

Flujo: usuario reenvía su factura al número de WhatsApp Business → Meta
webhook → `POST /webhooks/whatsapp` → se descarga el adjunto de la Graph API
→ mismo parser/validator/classifier de Fase 1 → se guarda en `invoices` →
se responde por WhatsApp con el resultado.

- **Verificación del webhook** (dos secretos distintos, no confundir):
  - `WHATSAPP_VERIFY_TOKEN`: string que tú inventas, solo para el handshake
    inicial `GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...`.
  - `WHATSAPP_APP_SECRET`: el App Secret real de tu app en Meta for
    Developers, usado para firmar cada POST con HMAC-SHA256
    (`X-Hub-Signature-256: sha256=<hex>`). El endpoint recalcula la firma
    sobre el body crudo y responde **401** si no coincide.
- **Descarga de adjuntos** ([whatsapp_service.py](whatsapp_service.py)): Meta
  **no** manda una URL descargable en el webhook, solo `document.id` (media
  ID). Se resuelve en dos llamadas a la Graph API: `GET /{media_id}` →
  URL temporal → `GET` esa URL (mismo Bearer token) → bytes reales.
- **Resolución de usuario por teléfono**: mismo patrón que el correo — si el
  número (`whatsapp_phone`) ya está registrado se usa esa cuenta; si no, se
  crea una cuenta mínima (RFC placeholder, contraseña aleatoria
  inutilizable, nombre tomado de `contacts[].profile.name` si Meta lo manda).
- **Respuesta por WhatsApp**: al terminar de procesar, se envía un mensaje de
  texto de vuelta con el resultado (✅/⚠️/❌/📄 según el estatus). Si el envío
  falla, se registra en el log pero **no** rompe el webhook — la factura ya
  quedó guardada.
- **Resiliencia**: fallos al descargar el adjunto o enviar la respuesta se
  capturan y registran; el webhook completo sigue devolviendo `200` (evita
  que Meta reintente el payload entero por un fallo parcial en una sola
  factura de varias). Solo una **firma inválida** responde `401`.

> ⚠️ **Dependencia:** se usa `httpx` (ya presente en el proyecto) en vez de
> `aiohttp` para las llamadas a la Graph API — evita sumar una librería
> nueva que duplica algo que ya teníamos.
>
> ⚠️ **Migración de esquema:** se agregó la columna `whatsapp_phone` a
> `users`. `init_db()`/`create_all` solo crea tablas nuevas — si tu tabla
> `users` en Supabase ya existe, necesitas un `ALTER TABLE users ADD COLUMN
> whatsapp_phone VARCHAR(20) UNIQUE` manual antes de desplegar esta fase.

## Seguridad (Fase 2a + 2b)

- Contraseñas con **bcrypt** (mínimo 8 caracteres, validado en Pydantic).
- **JWT HS256** con dos tipos de token, distinguidos por el claim `"type"`:
  - `access_token`: 1 h, para llamar a la API.
  - `refresh_token`: 7 días, **solo** sirve en `/auth/refresh` (un access_token
    no funciona ahí, y viceversa — `verify_token`/`verify_refresh_token` cada
    uno exige su tipo).
- **Rate limiting**: `/auth/login` acepta máx **5 intentos/minuto por IP**
  (`slowapi`); el 6º responde `429` con `{"detail": "Demasiados intentos..."}`.
  Cuenta también los intentos fallidos (protege contra fuerza bruta).
- **RFC**: exactamente 13 caracteres alfanuméricos (persona física), formato
  `AAAA000000XXX`. Se normaliza a mayúsculas. Rechaza con `422` si no cumple.
- **Chat resiliente a fallos de OpenAI**: `RateLimitError`/`APIError`/
  `OpenAIError` se capturan en `chat.py`, se registran en el log y el usuario
  recibe una respuesta legible (nunca un traceback). Un error *no* relacionado
  con OpenAI (bug interno) sí devuelve `500` desde el endpoint.
- **Logging**: `logs/facturapp.log`, rotativo (5 MB × 5 backups), nivel INFO.
  Configurado una sola vez en el `lifespan` de la app (`setup_logging()`,
  idempotente).
- Aislamiento de datos: cada query incluye `WHERE user_id = current_user.id`.
- Parser XML endurecido pendiente (ver "Deuda técnica").

## Estructura

```
facturapp/
├── main.py          # FastAPI + endpoints auth/chat/api
├── config.py        # Settings (pydantic-settings, lee .env)
├── database.py      # Engine + sesión (Supabase Postgres / SQLite)
├── models.py        # User, Invoice, ChatMessage (SQLAlchemy)
├── auth.py          # JWT (access + refresh) + bcrypt + get_current_user
├── security.py      # Rate limiter (slowapi)
├── chat.py          # Chat OpenAI (function calling) + 5 tools + error handling
├── accounts.py      # Aprovisionamiento de cuentas mínimas (compartido email/WhatsApp)
├── email_service.py # Resolución de usuario + adjuntos (webhook SendGrid)
├── whatsapp_service.py  # Firma HMAC + descarga media + envío (Meta Cloud API)
├── schemas.py       # Pydantic (register/login/token/chat/email/whatsapp)
├── parser.py · validator.py · classifier.py   # Fase 1, SIN cambios
├── export.py        # ZIP/Excel (mock)
├── templates/dashboard.html
├── seeds/           # 4 CFDI + usuarios-test.sql
└── tests/           # 91 tests (offline)
scripts/migrate_to_supabase.py
requirements.txt
```

## Deuda técnica / próximos pasos

- **Seguridad XML:** endurecer `parse_cfdi` contra XXE/billion-laughs
  (`resolve_entities=False`). Detectado en revisión de Fase 1.
- **Async real:** SQLAlchemy es síncrono; migrar a async si sube la carga.
- **Rotación de refresh tokens**: hoy no se invalida el refresh_token viejo al
  usarlo (no hay revocación/blacklist). Suficiente para Fase 2b; considerar
  para producción con más usuarios.
- **`/webhooks/sendgrid` sin verificación de origen** (ver advertencia arriba):
  agregar allowlist de IPs de SendGrid o un secreto en la URL antes de
  exponer el endpoint públicamente.
- **Adaptador multipart→JSON real** (SendGrid): falta el relay que convierta
  el POST crudo de SendGrid Inbound Parse (`multipart/form-data`) al JSON
  que ese endpoint espera.
- **Migración de esquema** (WhatsApp): la columna `whatsapp_phone` es nueva;
  si la tabla `users` de Supabase ya existe, requiere un `ALTER TABLE`
  manual (`create_all` no altera tablas existentes).

## Qué viene

- Conectar a Supabase real con las credenciales de producción (incluye el
  `ALTER TABLE` de `whatsapp_phone` si la tabla ya existía).
- Configurar los adaptadores reales de SendGrid y Meta (ver advertencias).
- **Fase 3c:** Paquete Abril (monetización).
- **Fase 4:** export Excel/ZIP funcional.
