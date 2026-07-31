# FacturasMX — Migración a Supabase (Fase M7)

Migración de `facturapp` de Railway/FastAPI/SQLite → Supabase Edge
Functions/TypeScript/PostgreSQL. **El proyecto Python en `facturapp/` sigue
corriendo en Railway sin cambios** — esta migración avanza en paralelo hasta
que esté completa y validada; no reemplaza nada todavía.

## Estado de la migración

| Fase | Contenido | Estado |
|------|-----------|--------|
| M1 | Estructura base: esquema Postgres + placeholders de Edge Functions | ✅ |
| M2 | Portar `parser.py` (CFDI 4.0) a TypeScript | ✅ |
| M3 | Portar `validator.py` + `classifier.py` a TypeScript | ✅ |
| M4 | Webhook real de WhatsApp (HMAC, descarga de media, guardar, responder) | ✅ |
| M5 | Webhook real de SendGrid (email inbound) | ✅ |
| M5.5 | Endpoint `/api/chat` autenticado (JWT Bearer, OpenAI function calling) | ✅ |
| M6 | Migrar datos existentes de SQLite a este esquema | ✅ (ver caveat sobre datos de prueba) |
| M4b | Chat conversacional por WhatsApp (texto) + comandos rápidos + `debug_logs` | ✅ |
| M7 | API que faltaba: `/auth/*`, `/api/user/profile`, `/api/summary`, `/api/invoices`, `/api/public/*` | ✅ |
| M8 | Rate limiting de `/auth/login` con estado en Postgres | ✅ |
| M9 | El webhook de SendGrid acepta el `multipart/form-data` real | ✅ |
| **M10** | Verificación de origen en el webhook de SendGrid | ✅ Este documento |

## Estructura

```
supabase/
├── functions/
│   ├── whatsapp-webhook/index.ts   # GET + POST: documentos (M4) + texto/chat (M4b)
│   ├── sendgrid-webhook/index.ts   # POST completo (Fase M5)
│   ├── api-chat/index.ts           # POST autenticado, JWT Bearer (Fase M5.5)
│   ├── auth-register/index.ts      # POST /auth/register (Fase M7)
│   ├── auth-login/index.ts         # POST /auth/login (Fase M7)
│   ├── auth-refresh/index.ts       # POST /auth/refresh (Fase M7)
│   ├── api-user-profile/index.ts   # GET /api/user/profile (Fase M7)
│   ├── api-summary/index.ts        # GET /api/summary (Fase M7)
│   ├── api-invoices/index.ts       # GET /api/invoices + POST .../{id}/reclassify (Fase M7)
│   ├── api-public-summary/index.ts   # GET /api/public/summary?token=... (Fase M7)
│   ├── api-public-invoices/index.ts  # GET /api/public/invoices?token=... (Fase M7)
│   └── _shared/
│       ├── cors.ts                 # headers CORS compartidos
│       ├── types.ts                # interfaces TS: User, Invoice, ChatMessage
│       ├── parser.ts               # port de parser.py — CFDI 4.0 → objeto (Fase M2)
│       ├── parser.test.ts          # 8 tests Deno (port 1:1 de test_parser.py + 2 extra)
│       ├── classifier.ts           # port de classifier.py — reglas en memoria (Fase M3)
│       ├── classifier.test.ts      # 4 tests Deno (port 1:1 de test_classifier.py)
│       ├── validator.ts            # port de validator.py — 5 reglas (Fase M3)
│       ├── validator.test.ts       # 6 tests Deno (port 1:1 de test_validator.py)
│       ├── accounts.ts             # port de accounts.py — placeholderRfc (Fase M4)
│       ├── accounts.test.ts        # 3 tests
│       ├── whatsapp.ts             # port de whatsapp_service.py — HMAC, extracción, Graph API (Fase M4)
│       ├── whatsapp.test.ts        # 15 tests (solo lógica pura: HMAC, extracción, mapeo)
│       ├── email.ts                # port de email_service.py — remitente, adjuntos (Fase M5)
│       ├── email.test.ts           # 10 tests
│       ├── users.ts                # getOrCreateUserByPhone (M4) + getOrCreateUserByEmail (M5)
│       ├── users.test.ts           # 6 tests (contra fake_supabase_client)
│       ├── invoices.ts             # ingestInvoice — port de _ingest_invoice() de main.py (Fase M4, reusado en M5)
│       ├── invoices.test.ts        # 7 tests (contra fake_supabase_client)
│       ├── auth.ts                 # verifyAccessToken/getCurrentUser — JWT HS256, mismo SECRET_KEY que Python (Fase M5.5)
│       ├── auth.test.ts            # 11 tests
│       ├── chat.ts                 # port de chat.py — classifyIntent, TOOLS, chat() orquestador (M5.5) + history/getRecentChatHistory (M4b)
│       ├── chat.test.ts            # 16 tests
│       ├── whatsapp_commands.ts    # comandos rápidos de WhatsApp sin IA (Fase M4b, no en Python)
│       ├── whatsapp_commands.test.ts # 5 tests
│       ├── debug_log.ts            # logDebug() → facturapp.debug_logs (Fase M4b, no en Python)
│       ├── passwords.ts            # hashPassword/verifyPassword (bcryptjs) (Fase M7)
│       ├── passwords.test.ts       # 5 tests, incluye interoperabilidad real con bcrypt de Python
│       ├── rfc_validation.ts       # validateRfc() — port del field_validator de UserRegister (Fase M7)
│       ├── rfc_validation.test.ts  # 5 tests
│       ├── invoices_api.ts         # summaryForUser/listInvoicesForUser/reclassifyInvoiceById — API REST (Fase M7, distinto de chat.ts)
│       ├── invoices_api.test.ts    # 5 tests
│       ├── fake_supabase_client.ts # cliente Supabase FALSO solo para tests — no es Postgres real (select/insert/update/order/limit)
│       └── testdata/               # los mismos 4 XML de seed de Fase 1
├── migrations/
│   ├── 0001_initial_schema.sql     # esquema `facturapp` (users, invoices, chat_messages)
│   ├── 0002_seed_test_users.sql    # datos migrados de facturapp.db (Fase M6)
│   ├── 0003_debug_logs.sql         # facturapp.debug_logs (Fase M4b)
│   └── 0004_add_plan_column.sql    # facturapp.users.plan (Fase M7, faltaba desde M1)
├── config.toml
└── deno.json                       # import map (@libs/xml, @std/assert, @supabase/supabase-js) + tasks
```

## Parser CFDI (`_shared/parser.ts`, Fase M2)

Port 1:1 de `facturapp/facturapp/parser.py`, usando
[`@libs/xml`](https://jsr.io/@libs/xml) (JSR) en vez de `lxml`.

**Verificado, no solo revisado a mano:** se corrieron los 4 XML de seed por
AMBOS parsers (Python real vía el venv del proyecto, y TypeScript real vía
`deno run`) y se compararon programáticamente campo por campo — coinciden
exactamente en los 4 casos.

```bash
cd supabase
deno task test    # 8/8 tests
deno task check   # type-check
```

**Divergencias declaradas respecto a Python** (documentadas también como
comentario en el propio `parser.ts`, ninguna es silenciosa):

1. **Resolución de namespaces por prefijo literal, no por URI.** `lxml`
   resuelve `cfdi:Emisor` vía la URI real del namespace, sin importar qué
   prefijo use el documento. Aquí se matchea literalmente contra `cfdi:` y
   `tfd:` — el estándar de facto de todo el ecosistema CFDI (ningún PAC
   certificado usa otro prefijo). Resolver por URI real requeriría construir
   un mapa de prefijos desde los atributos `@xmlns:*` en cada nivel del
   árbol — complejidad extra para un caso que no ocurre en la práctica.
2. **Los campos de texto opcionales son siempre `string`** (`""` si faltan),
   nunca `string | null`. La interfaz `ParsedInvoice` se corrigió respecto a
   la propuesta inicial de esta fase porque `parser.py` real usa
   `campo.get(...) or ""` — jamás produce `null`. Confirmado en el port
   comparando contra la salida real de Python, no por inspección.

**Ajuste adicional (fuera del parser, pero mientras tenía Deno corriendo):**
los placeholders de `whatsapp-webhook` y `sendgrid-webhook` de Fase M1 usaban
`https://deno.land/std/http/server.ts` **sin versión fijada** — `deno check`
lo marcó con una advertencia real (`Implicitly using latest version`). Se
fijó a `@0.224.0` para que el deploy no dependa silenciosamente de cuál sea
la última versión de `std` en el momento de cada build.

## Validator + Classifier (`_shared/validator.ts`, `_shared/classifier.ts`, Fase M3)

Port 1:1 de `facturapp/facturapp/validator.py` y `classifier.py`.

**Verificado igual que el parser:** se corrieron los 10 casos (4 del
classifier + 6 del validator — válido, pago efectivo, RFC ajeno, UUID
duplicado, uso de CFDI incorrecto, emisor sin especialidad) por Python real
y TypeScript real, comparando programáticamente **incluyendo el contenido
completo de cada objeto `hallazgo`** (código, severidad y mensaje) — no solo
el estatus final. Coinciden exactamente en los 10 casos.

**Discrepancias encontradas entre el spec de esta fase y el sistema real**
(corregidas antes de escribir código, no después):

1. **No existe ninguna tabla `deduction_rules` en el sistema actual.**
   `classifier.py` es una lista de 9 reglas **en memoria**, cada una
   matcheando `uso_cfdi` (exacto) **y** un prefijo de `clave_prod_principal`
   **combinados** — no un lookup simple por clave de producto. El mismo
   prefijo (`"84"`) mapea a categorías distintas según el `uso_cfdi`: D02/D10
   → Colegiaturas, pero D07 → Seguros GMM. Una tabla `clave_prod_servicio
   UNIQUE → categoria` (lo que proponía el spec original) no puede
   representar esto sin perder información — habría sido una regresión
   silenciosa, no un port fiel. **No se creó ninguna migración
   `0002_deduction_rules.sql`** — el classifier se portó tal cual, como
   lista en memoria. Si más adelante se quiere hacer esto configurable
   desde Postgres, es una decisión de arquitectura nueva y consciente, no
   algo que deba colarse como efecto secundario de "portar lo que ya existe".
2. **`hallazgos` es `Hallazgo[]`** (objetos `{codigo, severidad, mensaje}`),
   **no `string[]`**. El campo `mensaje` es el texto que el usuario final lee
   en las respuestas de los webhooks de Fase 2a-3b de Python — reducir esto
   a solo códigos habría sido pérdida real de información funcional.
3. **Ni `validateInvoice` ni `classifyInvoice` son `async`.** No hay ninguna
   operación asíncrona real en la versión Python (`UUID_DUPLICADO` recibe el
   set de UUIDs ya resuelto como dato plano, no hace la consulta él mismo) —
   ni la habrá aquí mientras el classifier siga en memoria. `classifyInvoice`
   devuelve `{categoria, origen, confianza}` (el 3-tuple real de Python), no
   un string suelto — `confianza` se usa en `main.py` al guardar la factura,
   así que se preservó para que M4 pueda replicar esa integración.

```bash
cd supabase
deno task test    # 18/18 tests (8 parser + 4 classifier + 6 validator)
deno task check   # type-check limpio
```

## Webhook de WhatsApp completo (Fase M4)

`functions/whatsapp-webhook/index.ts` ya no es un placeholder: GET (handshake,
sin cambios desde M1) + POST real, port 1:1 de `whatsapp_webhook()` +
`_ingest_invoice()` en `main.py`, usando `whatsapp_service.py` como
referencia de la lógica de WhatsApp específica.

**Nota sobre la referencia usada:** al leer `whatsapp_service.py` y
`main.py` para portar, encontré que ambos archivos tienen ahora ediciones a
medio hacer — `whatsapp_service.py` tiene logging de depuración (`[VERIFY]`,
`[EXTRACT]`, etc.) agregado después de la Fase 3b, y `whatsapp_webhook()` en
`main.py` está **roto**: lectura del body duplicada, prints de depuración
sin terminar, y la función se corta sin `return` (se mezcla con el
comentario de la siguiente sección). No usé ese archivo como referencia —
usé la versión que ya había portado y verificado con 91/91 tests y un
smoke test real contra Meta en la Fase 3b de esta misma conversación.

**Estructura del código** (mismo patrón que M2/M3: piezas puras y
testeables en `_shared/`, el `index.ts` del webhook solo orquesta):

| Archivo | Contenido |
|---|---|
| `accounts.ts` | `placeholderRfc()` — determinístico, síncrono |
| `whatsapp.ts` | `verifyWhatsappSignature()`, `extractWhatsappMessages()`, `downloadMediaFromMeta()`, `sendWhatsappMessage()`, `whatsappReplyText()` |
| `users.ts` | `getOrCreateUserByPhone()` — resuelve o crea la cuenta por teléfono |
| `invoices.ts` | `ingestInvoice()` — el mismo `_ingest_invoice()` de Python, ahora compartido entre WhatsApp (M4) y el futuro SendGrid (M5) |

**Verificado en tres niveles** (de más a menos riguroso):

1. **46/46 tests** (`deno task test`) — HMAC válida/inválida/ausente,
   extracción de mensajes, mapeo de respuesta, y la lógica completa de
   `ingestInvoice` (XML válido, PDF, mal formado, UUID duplicado, RFC ajeno)
   contra un `FakeSupabaseClient` en memoria (`fake_supabase_client.ts`) —
   **no es Postgres real**, es una simulación mínima de la porción de la
   API que usamos; se declara así explícitamente en el propio archivo.
2. **`placeholderRfc` cruzado contra Python real** para el mismo seed —
   coincide exactamente (`PEND8A3B94BF7`).
3. **Llamada real a la Graph API de Meta** (`downloadMediaFromMeta` con un
   `media_id` falso, de solo lectura, sin efectos secundarios) usando el
   `WHATSAPP_ACCESS_TOKEN` real de `.env` — **encontró un problema real**:
   el token está **expirado** (`"Session has expired on Saturday,
   25-Jul-26..."`, típico de un token temporal de 24h de Meta). Si Railway
   usa este mismo token, la integración de WhatsApp en producción no puede
   descargar adjuntos ni enviar respuestas ahora mismo. Se necesita un
   **token de sistema permanente** (System User, desde Meta Business
   Settings) para producción — no un token temporal del panel de
   desarrollador.

**No se probó `sendWhatsappMessage` contra la API real** — a diferencia de
`downloadMediaFromMeta` (que es una lectura sin efectos secundarios),
enviar un mensaje real notificaría a un número de WhatsApp real. Eso
requiere autorización explícita tuya con un número de destino, no algo para
hacer sin preguntar.

**Otros hallazgos, señalados pero no corregidos (fuera del alcance de "no
tocar Railway/Python"):**
- `config.py` define el campo `whatsapp_token`, que por default de
  `pydantic-settings` busca la variable de entorno `WHATSAPP_TOKEN` — pero
  el `.env` real tiene `WHATSAPP_ACCESS_TOKEN`. Si Railway usa el mismo
  `.env`, `settings.whatsapp_token` estaría vacío en producción. Vale la
  pena que lo revises independientemente de esta migración.
- El `.env` real no tiene `WHATSAPP_APP_SECRET` en absoluto — combinado con
  la lógica de `whatsapp_webhook()` en Python (que **omite** la
  verificación de firma si el secreto no está configurado), esto podría
  significar que la verificación de firma está desactivada en producción
  ahora mismo.

Para el lado TypeScript se usaron los nombres de variable ya establecidos
en M1 (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, etc.) — no heredé el
posible bug de nombre del lado Python.

```bash
cd supabase
deno task test    # 46/46 tests
deno task check   # type-check limpio (incluye ambos webhooks)
```

## Webhook de SendGrid completo (Fase M5)

`functions/sendgrid-webhook/index.ts` ya no es un placeholder: port 1:1 de
`ingest_email_sendgrid()` en `main.py` (⚠️ el spec de esta fase decía
`ingest_email()` — esa es la función del endpoint autenticado de subida
manual, no la de SendGrid; usé la correcta). A diferencia de `main.py` en
M4, este archivo estaba intacto, sin ediciones a medio hacer.

**Más simple que WhatsApp (M4) — sin firma que verificar, sin descarga
remota, sin respuesta saliente** — reutiliza `ingestInvoice()` de
`invoices.ts` tal cual, sin ningún cambio (era exactamente el propósito de
haberlo hecho compartido en M4).

**Tres discrepancias entre el spec de esta fase y el sistema real** (igual
que en fases anteriores, corregidas antes de escribir código):

1. **SendGrid ya usa JSON en el sistema actual, no multipart.** Mi propia
   Fase 3a (Python) ya documentó esto como un adaptador/relay asumido — no
   se construyó un parser de `multipart/form-data` nuevo aquí, porque el
   sistema de referencia tampoco lo tiene. Construirlo ahora habría sido
   inventar comportamiento, no portarlo.
2. **`extractAttachments` filtra por extensión del filename (`.xml`/`.pdf`),
   no por `mimeType`**, y devuelve **como máximo un adjunto por tipo** (el
   último gana si hay varios del mismo tipo) — no una lista de "todos los
   adjuntos que pasan un whitelist de MIME", como sugería el spec.
3. **`getOrCreateUserByEmail` no recibe un parámetro `nombre`.** El nombre
   siempre se deriva de la parte local del email (`email.split("@")[0]`) —
   SendGrid no manda un "profile name" como sí lo hace el payload de
   contactos de WhatsApp.

**Verificado igual que M2/M3:** se corrieron los casos de `extractSenderEmail`
y `extractAttachments` (incluyendo el caso de "dos XML, gana el último") por
Python real y TypeScript real, comparando programáticamente — coinciden
exactamente.

```bash
cd supabase
deno task test    # 59/59 tests
deno task check   # type-check limpio (incluye los 2 webhooks)
```

## Endpoint `/api/chat` (Fase M5.5)

`functions/api-chat/index.ts`, port 1:1 de `chat_endpoint()`/`chat.py` en el
proyecto Python. A diferencia de los webhooks M4/M5, este **no es público**:
requiere `Authorization: Bearer <access_token>` real y responde 401 sin él.

**Hallazgo de seguridad más importante de esta fase:** el spec original
proponía validar el Bearer token contra la columna `facturapp.users.web_token`
— eso es **incorrecto**. `web_token` (`generate_web_token()` en Python) es un
string aleatorio de `secrets.token_urlsafe()` sin fecha de expiración, pensado
para otro flujo; el endpoint real de Python valida un **JWT de acceso HS256**
firmado con `SECRET_KEY` (`create_access_token()`/`get_current_user()`). Usar
`web_token` aquí habría creado un mecanismo de auth paralelo e incorrecto,
divergente del sistema real. `_shared/auth.ts` implementa el JWT real
(`verifyAccessToken()`, `getCurrentUser()`), verificado con interoperabilidad
real: un token emitido por el `create_access_token()` de Python fue
verificado exitosamente por `jose` en Deno con el mismo `SECRET_KEY`.

**Otras discrepancias entre el spec y el sistema real** (corregidas antes de
escribir código):

1. **No se pasa historial de conversación a OpenAI.** El spec asumía que sí
   y sugería portarlo "si la versión Python ya lo hace" — no lo hace: cada
   mensaje se procesa de forma independiente (`messages = [system, user]`,
   sin leer `chat_messages` previos). Se guardan en la tabla para historial
   visible al usuario, pero no se reenvían al modelo.
2. **No existe `execute_intent()`** en Python — el spec lo asumía como punto
   de entrada. `classify_intent()`/`ChatIntent` son código presente en
   `chat.py` pero **huérfano**: no está conectado a la orquestación real
   (que depende enteramente del function calling de OpenAI, no de
   clasificación de intención previa). Se portó `classifyIntent()` tal cual
   para paridad de comportamiento, pero no se usa en `chat()`.
3. **`reclassify_invoice` recibe `uuid` (string), no `invoice_id`
   (numérico)** — el spec asumía lo segundo.
4. **`export_package` es un mock también en Python** (`{status:
   "mock_fase4"}`), no genera un ZIP real — se portó como mock, no se
   inventó una implementación real.
5. **La forma de la respuesta es `{response, tools_used}`**, no `{response,
   metadata}` como sugería el spec.

**Por qué `verify_jwt = false` en `api-chat` es distinto al de los
webhooks:** en WhatsApp/SendGrid es porque el emisor externo no puede
producir ningún JWT. Aquí SÍ hay autenticación real — pero nuestros usuarios
tienen un JWT propio emitido por el backend Python (mismo `SECRET_KEY`, HS256),
no un JWT de Supabase Auth. Si `verify_jwt = true`, el gateway de Supabase
rechazaría con 401 cualquier request — incluso con un access token válido —
porque no lo emitió Supabase Auth. La verificación real ocurre dentro de la
función (`_shared/auth.ts`).

**Dependency injection en vez de `monkeypatch`:** igual que `ValidationEngine`
en M3, `chat()` recibe `chatCompletionFn` como parámetro en vez de importar
el cliente de OpenAI directamente — los módulos ES no permiten reasignar
exports como hace `monkeypatch.setattr()` en los tests de Python.

**`FakeSupabaseClient` se extendió en esta fase** (`fake_supabase_client.ts`):
`toolListInvoices` necesitaba `.order(col, {ascending})` y
`toolReclassifyInvoice` necesitaba `.update(patch).eq(...)` — ninguno de los
dos existía todavía porque los webhooks de M4/M5 nunca los ejercitaron. Se
agregaron ambos como parte de esta fase.

```bash
cd supabase
deno task test    # 83/83 tests
deno task check   # type-check limpio (incluye los 3 endpoints)
```

## Migración de datos (Fase M6)

`supabase/migrations/0002_seed_test_users.sql` — **no se aplicó automáticamente**;
es SQL generado para que lo revises y corras tú mismo en el SQL Editor de
Supabase (`supabase db push` también lo tomaría, si prefieres ese camino).

**Hallazgo importante antes de escribir nada:** se inspeccionó `facturapp.db`
directamente con el módulo `sqlite3` de Python (no hay `sqlite3` CLI
instalado en este entorno). Resultado real:

| Tabla | Filas |
|---|---|
| `users` | 2 |
| `invoices` | 0 |
| `chat_messages` | 0 |

Los 2 usuarios son **datos de prueba** (`daniela@example.com`,
`bruno@example.com`, dominio `@example.com`) — los mismos RFC de fixture
usados en los tests de M4/M5.5, no cuentas reales de producción. No hay
ninguna factura ni mensaje de chat que migrar todavía. Si la producción real
vive en un volumen de Railway distinto a este archivo local, esta migración
no la cubre — habría que repetir el proceso apuntando a ese SQLite real.
Confirmado contigo antes de generar el SQL: se decidió migrar estos 2
usuarios de prueba igual.

**Divergencias entre el script propuesto para esta fase y el esquema real:**

1. `facturapp.users.plan` (columna real en SQLite) no existe en el schema
   de Supabase (`0001_initial_schema.sql`) — se descarta, no se migra.
2. SQLite **no tiene** columna `whatsapp_phone` en absoluto (el script
   propuesto la asumía) — queda `NULL` en Supabase, comportamiento correcto
   ya que estas cuentas no se crearon vía WhatsApp.
3. `invoices` usa `creado_en`, no `created_at` como asumía el script — sin
   efecto hoy (0 filas), pero señalado para cuando sí haya facturas que
   migrar.
4. Se agregó un `SELECT setval(...)` al final para realinear la secuencia
   `BIGSERIAL` de `facturapp.users` con el último `id` insertado
   explícitamente — si no se hace esto, el próximo usuario creado por la
   app (que usa `DEFAULT nextval(...)`, no un id explícito) podría chocar
   con id=1 o id=2.

**Nota sobre codificación:** al generar el `.sql` con redirección de stdout
de Bash en Windows, el acento de "Daniela Ávila" se corrompió a un carácter
inválido (mismo problema ya documentado en la Fase M2). Se corrigió
escribiendo el archivo directamente desde Python con `encoding='utf-8'` en
vez de depender de la redirección de la shell.

```bash
# Verificar en el SQL Editor de Supabase después de aplicar:
SELECT COUNT(*) FROM facturapp.users;   -- debe dar 2
```

## Chat conversacional por WhatsApp + `debug_logs` (Fase M4b)

**Contexto:** existe otro proyecto (bot de WhatsApp para inventario de rancho)
en este mismo Supabase que ya corre en producción real, documentado en
`WHATSAPP_BOT_ARCHITECTURE.md` (raíz del repo). Esta fase adopta ese patrón
de arquitectura probado — pero **NO es un port de Python**: el
`whatsapp_webhook()` original solo procesa documentos adjuntos (facturas),
nunca texto conversacional. Todo lo de esta sección es una extensión nueva,
declarada explícitamente, no un comportamiento heredado del sistema Python.

**Qué se agregó:**

1. **`facturapp.debug_logs`** (`0003_debug_logs.sql`) — tabla de diagnóstico
   para el webhook (firma inválida, errores de descarga/procesamiento/chat).
   Sin esto, la única forma de depurar problemas de Meta era
   `supabase functions logs`, que rota rápido y no persiste. Mismo patrón
   que `debug_logs` del bot de referencia, pero dentro del esquema
   `facturapp` (no `public`) para no colisionar con la tabla homónima del
   otro proyecto.
2. **`extractWhatsappTextMessages()`** (`whatsapp.ts`) — extrae mensajes de
   tipo `"text"` del payload de Meta (antes solo se extraían `"document"`).
3. **`interceptQuickCommand()`** (`whatsapp_commands.ts`, nuevo) — intercepta
   saludos (`"hola"`) y pedidos de ayuda (`"ayuda"`) con una respuesta fija,
   **antes** de llamar a OpenAI — ahorra latencia/costo en los mensajes más
   comunes. Deliberadamente conservador: solo matchea el mensaje completo
   (con `^...$`), nunca substrings — `"hola, cuánto llevo en médicos"` NO se
   intercepta, pasa a OpenAI completo.
4. **`chat()` acepta `history` opcional** (`chat.ts`) — cuarto parámetro,
   default `[]`. El endpoint `/api/chat` (M5.5, port fiel de Python) sigue
   sin pasarlo — preserva exactamente el comportamiento portado. El webhook
   de WhatsApp sí lo usa: llama a `getRecentChatHistory()` (últimos 20
   mensajes de `facturapp.chat_messages` para ese `user_id`, orden
   cronológico) para dar continuidad conversacional — algo que no existe en
   ningún endpoint del sistema Python original.
5. **`whatsapp-webhook/index.ts` ahora despacha por tipo de mensaje:**
   `"document"` sigue el flujo de M4 sin cambios (`ingestInvoice`);
   `"text"` resuelve/crea el usuario por teléfono, intenta un comando
   rápido, y si no aplica llama a `chat()` con historial reusando
   **exactamente** las mismas 5 herramientas de M5.5 (`get_summary`,
   `list_invoices`, `reclassify_invoice`, `export_package`,
   `explain_deductions`) — un usuario puede ahora preguntar "¿cuánto llevo
   en médicos?" por WhatsApp, no solo por el dashboard web.

**Extensión del fake client:** se agregó `.limit(n)` a `FakeQueryBuilder`
(necesario para `getRecentChatHistory`), y las tablas `chat_messages` y
`debug_logs` al estado inicial de `FakeSupabaseClient`.

**Verificado con 23 tests nuevos** (`whatsapp.test.ts` +4,
`whatsapp_commands.test.ts` +5, `chat.test.ts` +3): extracción de texto,
comandos rápidos (incluyendo el caso negativo de no-interceptar preguntas
reales), `chat()` con y sin historial, y `getRecentChatHistory()` con
aislamiento por usuario.

```bash
cd supabase
deno task test    # 95/95 tests
deno task check   # type-check limpio
```

### `whatsapp-webhook-bundled.ts` (raíz del repo)

`bundle_webhook.py` (raíz del repo) concatena todos los módulos que usa
`whatsapp-webhook/index.ts` en un solo archivo — útil para pegar el webhook
completo en un solo lugar (p.ej. el editor de funciones del dashboard de
Supabase) sin depender de imports relativos entre archivos.

**Se encontró y corrigió un bundle desactualizado y roto** de una sesión
previa: le faltaban `cors.ts` y `accounts.ts` por completo (`corsHeaders` y
`placeholderRfc` quedaban indefinidos), el regex que quitaba imports
internos solo cubría `../_shared/...` — nunca los imports `./...` entre
módulos del mismo directorio (`invoices.ts` importando `./parser.ts`, etc.
quedaban colgando, apuntando a archivos inexistentes) —, y era de antes de
M4b/M5.5, sin `auth.ts`/`chat.ts`/`debug_log.ts`/`whatsapp_commands.ts` — es
decir, sin el chat conversacional en absoluto.

`bundle_webhook.py` corregido: incluye los 11 módulos correctos en orden de
dependencia, reescribe especificadores "bare" (`@libs/xml/parse`, `openai`,
`@supabase/supabase-js`) a su forma explícita `jsr:`/`npm:` (el bundle vive
fuera de `supabase/`, sin el import map de `deno.json`), deduplica imports
externos repetidos entre módulos, y agrega un alias de compatibilidad
(`type AuthenticatedUser = AppUser`) porque `chat.ts` importa ese tipo desde
`auth.ts`, que deliberadamente no se incluye (solo lo usa `api-chat`, no el
webhook de WhatsApp). Verificado con `deno check whatsapp-webhook-bundled.ts`
— limpio.

```bash
python3 bundle_webhook.py   # regenerar tras cualquier cambio en los módulos listados
```

## API que faltaba: auth + summary/invoices/reclassify + público (Fase M7)

**Contexto:** hasta M5.5, solo se habían portado los webhooks (WhatsApp,
SendGrid) y `/api/chat`. Al revisar `main.py` completo se encontró que
faltaba **toda la capa de autenticación** (`/auth/register`, `/auth/login`,
`/auth/refresh`) y la API CRUD principal (`/api/user/profile`,
`/api/summary`, `/api/invoices`, `/api/invoices/{id}/reclassify`,
`/api/public/summary`, `/api/public/invoices`) — sin `/auth/login`, nadie
podía obtener un access token para usar `/api/chat` en la versión Supabase
en absoluto. Esta fase cierra ese hueco.

**Nuevos módulos compartidos:**

- **`passwords.ts`** — `hashPassword`/`verifyPassword` con `bcryptjs` (JS
  puro) en vez del `bcrypt` de Python (bindings nativos en C). **Verificado
  con interoperabilidad real y bidireccional**: un hash generado por
  `bcrypt.hashpw()` en Python fue verificado exitosamente por
  `bcryptjs.compareSync()` en Deno, y un hash generado por `bcryptjs` fue
  verificado exitosamente por `bcrypt.checkpw()` en Python — mismo formato
  `$2a$`/`$2b$` estándar en ambos sentidos, no una reimplementación
  distinta.
- **`rfc_validation.ts`** — `validateRfc()`, port del `field_validator`
  de `UserRegister` en `schemas.py` (13 caracteres, formato
  `AAAA000000XXX`, upper + trim).
- **`invoices_api.ts`** (nuevo, **deliberadamente separado de `chat.ts`**)
  — `summaryForUser`, `listInvoicesForUser`, `reclassifyInvoiceById`. Son
  funciones Python distintas a las que usa el chat, con formas de
  respuesta distintas:
  - `_summary_for_user()` (usada por `/api/summary` y
    `/api/public/summary`) incluye `num_facturas`; `tool_get_summary()` de
    `chat.py` (ya portado en `chat.ts`, Fase M5.5) **no** lo incluye —
    confirmado leyendo ambas funciones de Python lado a lado, no son la
    misma.
  - `list_invoices()` (REST) devuelve el dict **completo** de cada
    factura (`Invoice.to_dict()`: 18 campos, incluyendo `hallazgos` y
    todos los campos fiscales); `tool_list_invoices()` de chat.py resume a
    6 campos para que quepan en una respuesta conversacional.
  - El reclasificador REST (`/api/invoices/{id}/reclassify`) identifica la
    factura por **`id` numérico** (primary key); el tool de chat
    (`toolReclassifyInvoice`, ya existente) identifica por **`uuid_fiscal`**
    — son rutas Python distintas con contratos distintos, ambas portadas
    fielmente cada una a su manera.
- **`auth.ts` extendido** — `createAccessToken`, `createRefreshToken`,
  `verifyRefreshToken`, `generateWebToken` (antes solo tenía
  `verifyAccessToken`/`getCurrentUser`, Fase M5.5).

**Hallazgo adicional corregido en esta fase:** el esquema `facturapp.users`
(`0001_initial_schema.sql`, Fase M1) no tenía columna `plan` — pero sí
existe en el `User` de SQLAlchemy original (`models.py`:
`plan = Column(String(20), default="free")`) y se devuelve en
`/api/user/profile`. Se agregó vía `0004_add_plan_column.sql`
(`alter table ... add column if not exists plan text not null default
'free'`), sin tocar las tres tablas existentes.

**Nuevos endpoints** (8 Edge Functions, todas con `verify_jwt = false` en
`config.toml` — mismo motivo que `api-chat`: JWT propio, no de Supabase
Auth, excepto los `api-public-*` que no usan JWT en absoluto):

| Función | Ruta Python original | Nota |
|---|---|---|
| `auth-register` | `POST /auth/register` | Valida RFC/email/password, hashea con bcrypt |
| `auth-login` | `POST /auth/login` | Emite access + refresh token |
| `auth-refresh` | `POST /auth/refresh` | Requiere refresh token (Bearer), emite nuevo access token |
| `api-user-profile` | `GET /api/user/profile` | Requiere access token |
| `api-summary` | `GET /api/summary` | Requiere access token |
| `api-invoices` | `GET /api/invoices` + `POST /api/invoices/{id}/reclassify` | Una función, rutea por método + sufijo de path |
| `api-public-summary` | `GET /api/public/summary?token=` | Sin JWT — autenticado por `web_token` |
| `api-public-invoices` | `GET /api/public/invoices?token=` | Sin JWT — autenticado por `web_token` |

**Divergencia declarada — rate limiting del login:** Python aplica
`@limiter.limit("5/minute")` (slowapi, contador en memoria del proceso) a
`/auth/login`. Un límite en memoria **no tiene sentido en Edge
Functions** — cada invocación puede caer en una instancia distinta sin
estado compartido; portarlo tal cual habría sido un límite falso, una
falsa sensación de protección. **No se implementó** — requiere una
solución real (contador en Postgres, o rate limiting a nivel de gateway
de Supabase), fuera de alcance de este port. Señalado explícitamente, no
omitido en silencio.

**Verificado con 24 tests nuevos** (`passwords.test.ts` +5 —incluyendo la
interoperabilidad bcrypt real—, `rfc_validation.test.ts` +5,
`invoices_api.test.ts` +5, `users.test.ts` +4, `auth.test.ts` +5).

```bash
cd supabase
deno task test    # 119/119 tests
deno task check   # type-check limpio (11 endpoints)
```

## Por qué no hubo migración de datos

La Fase M6 migró lo que había en el `facturapp.db` local: 2 usuarios de
prueba `@example.com`, 0 facturas, 0 mensajes. Quedó pendiente la duda de
si la producción real en Railway tenía datos acumulados aparte. **La
respuesta es que no, y se verificó en vez de suponerse.**

Lo que se comprobó consultando Railway directamente (posible porque ambos
sistemas comparten `SECRET_KEY`, así que se pueden firmar tokens válidos):

| Hecho | Cómo se verificó |
|---|---|
| La app está viva y expone los webhooks | `/health` responde 200; el handshake GET de WhatsApp devuelve el challenge |
| Su base de datos está vacía | un usuario de sondeo recibió `id = 1` — el autoincrement arrancó de cero |
| No hay volumen montado | Railway no ofrece esa opción en ese servicio |
| La WABA nunca apuntó a esta app | estaba suscrita a `WA DevX Webhook Events 1P App`, la app de pruebas de Meta |

El último renglón explica los demás. Como la cuenta de WhatsApp entregaba
los eventos a la app placeholder de Meta y no a FactuApp, **los mensajes
nunca llegaron a Railway**. No se perdieron facturas: nunca entró ninguna.
El canal principal del producto no funcionó en producción hasta que se
corrigió esa suscripción (ver "Configuración de Meta que no es evidente").

De fondo queda un problema que la versión Supabase ya no tiene:
`DATABASE_URL=sqlite:///./facturapp.db` es una ruta relativa dentro del
contenedor, y sin un volumen montado ahí vive en el sistema de archivos
efímero. Aunque los mensajes hubieran llegado, cada deploy habría borrado
todo sin dejar error en ningún lado. Postgres es persistente por diseño, así
que el corte resuelve eso por construcción.

**Nota metodológica:** antes de concluir "no hay datos" se validó el método
de sondeo, porque un `401` puede significar tanto "el usuario no existe"
como "el token está mal construido". Se registró un usuario y se comprobó
que sí era legible con un token firmado igual — solo entonces los `401`
previos pasaron a ser evidencia de ausencia.

## Rate limiting de `/auth/login` (Fase M8)

Cierra la última brecha de seguridad conocida: hasta M7, `auth-login`
aceptaba intentos de contraseña ilimitados desde una URL pública.

**No es un port.** Python usa slowapi
(`@limiter.limit("5/minute")` con `key_func=get_remote_address`), un
contador en memoria del proceso. En Edge Functions cada invocación puede
caer en una instancia distinta, así que ese contador no limita nada —
portarlo tal cual habría dado una falsa sensación de protección. Se
conserva el mismo límite efectivo (5 por minuto), pero el estado vive en
Postgres.

**La cuenta vive en SQL, no en TypeScript.** `facturapp.registrar_intento()`
(en `0006_rate_limit.sql`) hace el conteo y el registro dentro de la misma
función porque tienen que ser **atómicos**: con dos queries separadas desde
la Edge Function, dos peticiones simultáneas leerían el mismo conteo y
pasarían ambas — exactamente la condición que provoca un atacante.

**Ventana deslizante, no fija.** Cuenta los intentos de los últimos 60
segundos en vez de reiniciar en marcas de reloj fijas. Una ventana fija
permite el doble del límite a caballo entre dos ventanas: 5 al final de un
minuto más 5 al inicio del siguiente.

**Divergencia deliberada respecto a Python: se limita por IP _y_ por email.**
slowapi solo usa la IP, lo que deja completamente abierto el ataque
distribuido (muchas IPs contra una misma cuenta), que es el caso realista
del que uno quiere protegerse. Ser fiel al original aquí habría sido fiel e
inútil. Las dos claves se registran siempre, incluso cuando una ya bloqueó:
si al bloquear por IP no se acumulara el intento contra el email, un
atacante rotando IPs nunca llegaría al límite de la cuenta objetivo.

Dos decisiones más, explícitas:

- **El chequeo corre antes de bcrypt.** Verificar la contraseña es caro a
  propósito (10 rounds); cortar antes evita que el propio rate limiting se
  convierta en un vector de agotamiento de CPU.
- **Un error de base de datos permite el intento** (falla abierto). Convertir
  una caída de Postgres en un bloqueo total de autenticación para todos los
  usuarios parecía peor que la alternativa; el login va a fallar igual en la
  siguiente consulta y el error queda en el log. Es discutible — fallar
  cerrado es un cambio de una línea en `registrarIntento()`.

**Qué cubren los 11 tests y qué no.** Cubren la extracción de la IP desde
los headers del proxy, la composición de las claves, y la reacción del
llamador a cada respuesta posible de la BD. **No** cubren el conteo ni la
atomicidad: esa lógica es SQL, y reimplementarla en TypeScript solo probaría
la reimplementación. Eso se verificó contra Postgres real (ver la tabla de
"Verificado en producción").

## Esquema Postgres (`0001_initial_schema.sql`)

Todo vive en un **esquema dedicado `facturapp`** (no `public`) para convivir
en el mismo proyecto Supabase que RanchoApp2-DB sin colisionar con sus
tablas. Tres tablas:

- **`facturapp.users`** — `hashed_password` es **nullable** (a diferencia
  del proyecto Python, donde las cuentas auto-creadas por email/WhatsApp
  reciben una contraseña aleatoria inutilizable): aquí simplemente se deja
  `NULL` — más simple, mismo efecto (no habilita login por password hasta
  que el usuario se registre).
- **`facturapp.invoices`** — `UNIQUE(user_id, uuid_fiscal)` reemplaza a
  nivel de base de datos la verificación de UUID duplicado que en Python
  vivía solo en `ValidationEngine` (aplicación). Montos en `NUMERIC(12,2)`
  en vez de `FLOAT` — evita errores de precisión de punto flotante en
  dinero, una mejora real sobre el esquema SQLAlchemy original.
- **`facturapp.chat_messages`** — igual que en Python.

**Cambio respecto al SQL propuesto originalmente:** se quitaron los índices
explícitos `idx_users_whatsapp_phone` e `idx_users_web_token` — ambas
columnas ya son `UNIQUE`, y Postgres crea automáticamente un índice único
para cada restricción `UNIQUE`. Un `CREATE INDEX` adicional sobre la misma
columna sería 100% redundante (duplica el índice sin ningún beneficio).

**Pendiente para fases futuras (fuera de alcance de M1):**
- Row Level Security (RLS): no se activó porque las Edge Functions acceden
  con la `service_role` key (que ignora RLS de cualquier forma) — solo
  importaría si en el futuro se expone `facturapp` directamente a un
  cliente `supabase-js` desde el navegador.

## Secrets de Supabase

**No se hardcodean — se configuran con `supabase secrets set`:**

```bash
supabase secrets set OPENAI_API_KEY=sk-...
supabase secrets set OPENAI_MODEL=gpt-4o        # opcional, default gpt-4o
supabase secrets set SECRET_KEY=...             # mismo valor que en Railway/Python — firma (auth-login/refresh) y verifica (api-chat, api-user-profile, api-summary, api-invoices) los JWT
supabase secrets set WHATSAPP_ACCESS_TOKEN=...
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...
supabase secrets set WHATSAPP_VERIFY_TOKEN=...
supabase secrets set WHATSAPP_APP_SECRET=...
supabase secrets set SENDGRID_WEBHOOK_SECRET=...   # Fase M10 — ver abajo
```

`SENDGRID_WEBHOOK_SECRET` es un secreto **inventado por ti** (no lo da
SendGrid): se configura aquí y se embebe en la URL de destino de Inbound
Parse como Basic auth. Sin él, el webhook de correo queda **sin
verificación de origen** — solo avisa en el log y acepta cualquier
petición.

### Configurar el correo entrante (SendGrid Inbound Parse)

**Usa un subdominio, no el dominio raíz.** Los registros MX solo pueden
apuntar a un proveedor a la vez: si apuntas el raíz a SendGrid, cualquier
correo corporativo existente (Google Workspace, Microsoft 365) deja de
recibir. Un subdominio tiene MX independientes.

1. **DNS del dominio** — agregar (sin tocar los MX existentes del raíz):

   | Tipo | Nombre | Apunta a | Prioridad |
   |---|---|---|---|
   | `MX` | `facturas` | `mx.sendgrid.net` | `10` |

2. **SendGrid → Settings → Inbound Parse → Add Host & URL**
   - Receiving Domain: `facturas.<tu-dominio>`
   - Destination URL, con el secreto como Basic auth (así viaja en un
     header y no en la URL, que Supabase registra en sus logs):
     ```
     https://facturapp:<SENDGRID_WEBHOOK_SECRET>@<project-ref>.supabase.co/functions/v1/sendgrid-webhook
     ```
   - **Dejar "POST the raw, full MIME message" DESACTIVADO.** Activado manda
     el MIME crudo, que este webhook no parsea; desactivado manda el
     `multipart/form-data` ya parseado, que es lo que espera (Fase M9).

`WHATSAPP_VERIFY_TOKEN` y `WHATSAPP_APP_SECRET` son **dos secretos
distintos** (mismo matiz que en la Fase 3b de Python): el primero solo sirve
para el handshake `GET` inicial; el segundo firma cada `POST` real con
HMAC-SHA256 (`X-Hub-Signature-256`).

**`SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` NO necesitan `secrets set`**
— Supabase las inyecta automáticamente en el runtime de toda Edge Function
desplegada. El código las lee directo de `Deno.env` (ver
`whatsapp-webhook/index.ts`).

## `config.toml` — detalle importante

`verify_jwt = false` está puesto explícitamente en ambas funciones
(`whatsapp-webhook`, `sendgrid-webhook`). **Es obligatorio**: por defecto,
el gateway de Supabase exige un JWT de Supabase Auth en cada llamada a una
Edge Function. SendGrid y Meta no pueden generar ese JWT — sin este ajuste,
todo webhook externo recibiría `401` antes siquiera de llegar al código.

`schemas = ["public", "facturapp", "graphql_public"]` en `[api]` — **esto
sí se usa desde M4**: `users.ts`/`invoices.ts` acceden a Postgres vía
`supabase-js` (PostgREST), llamando `.schema("facturapp")` en cada query —
no una conexión directa a Postgres. Sin esta línea en `config.toml`, esas
llamadas fallarían contra el proyecto real aunque compilen bien localmente.

## Aplicar la migración

**Con Supabase CLI** (requiere login interactivo). Los pasos van en este
orden a propósito — ver las notas de más abajo:

```bash
npm install -g supabase          # o npx supabase ... en cada comando
supabase login
supabase link --project-ref <tu-project-ref>

supabase config push             # ← NO omitir: ver "Trampas del deploy"
supabase db push

for fn in whatsapp-webhook sendgrid-webhook api-chat \
          auth-register auth-login auth-refresh \
          api-user-profile api-summary api-invoices \
          api-public-summary api-public-invoices; do
  supabase functions deploy $fn
done
```

Los secretos (`OPENAI_API_KEY`, `SECRET_KEY`, `WHATSAPP_*`) se configuran
aparte — ver la sección "Secrets de Supabase".

**Verificar que las tablas existen** (SQL Editor del dashboard, o `psql`):

```sql
SELECT * FROM facturapp.users;       -- debe responder vacío, no error
SELECT * FROM facturapp.invoices;
SELECT * FROM facturapp.chat_messages;
```

**Verificar el webhook de WhatsApp** (después de `functions deploy`):

```bash
curl "https://<tu-project-ref>.supabase.co/functions/v1/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=12345"
# Debe responder: 12345 (con 200)
```

### Trampas del deploy (encontradas al desplegar M7 de verdad)

Todas estas costaron tiempo real la primera vez. Están aquí para que la
segunda vez no.

**1. El schema `facturapp` no basta con marcarlo en el dashboard.**

Síntoma: toda función que toca la BD devuelve `500`, y el log muestra
`PGRST106 / Invalid schema: facturapp`, con el hint
`Only the following schemas are exposed: public, graphql_public`.

Lo confuso es que el dashboard (Data API → Settings → Exposed schemas) ya
mostraba `facturapp` marcado, y el valor **sí** estaba guardado del lado
del servidor — el diff de `supabase config push` lo confirmó. Aun así
PostgREST seguía sirviendo la lista vieja. Reiniciar el proyecto
(Settings → General → Restart project) **no** lo resolvió. Lo que lo
destrabó fue `supabase config push`, que hace que la plataforma reaplique
la config de la API completa. Por eso ese comando va en la secuencia de
arriba, antes de `db push`.

Nota: `pgrst.db_schemas` **no** vive en `pg_roles` en un proyecto hospedado
(lo inyecta la plataforma como variable de entorno del contenedor), así que
`select rolconfig from pg_roles where rolname='authenticator'` no sirve
para diagnosticar esto, y `notify pgrst, 'reload config'` tampoco aplica.

Ojo con el efecto secundario: `config push` empuja **todo** el
`config.toml`, incluida la sección `[auth]`. Si aceptas ese diff, la
config de Supabase Auth del proyecto remoto se sobrescribe con los valores
de desarrollo local (`site_url` a `127.0.0.1`, confirmaciones por email y
MFA desactivadas). Hoy es inocuo porque FacturasMX no usa Supabase Auth
—tenemos JWT propio con `SECRET_KEY`— pero hay que revisarlo si algún día
se activa.

**2. Los grants del schema no son automáticos.**

Supabase aplica los grants de `anon`/`authenticated`/`service_role`
automáticamente sobre `public`, pero no sobre un schema creado aparte. Sin
`grant usage on schema facturapp`, aunque el schema esté expuesto, toda
query falla. Está resuelto en `0005_grant_facturapp_schema_access.sql`,
que además deja `alter default privileges` puestos para que las tablas de
fases futuras no requieran repetir los grants.

**3. El import map de `deno.json` no existe en el bundler remoto.**

Síntoma: `supabase functions deploy` falla con
`Relative import path "openai" not prefixed with / or ./ or ../`.

El `deno.json` con el import map solo aplica localmente (`deno test`,
`deno check`). El bundler de Supabase no lo lee, así que **todo import
tiene que ser explícito** en los archivos: `npm:openai@4`,
`jsr:@std/assert@1`, `jsr:@supabase/supabase-js@2`, `jsr:@panva/jose@6`,
`npm:bcryptjs@2`, `jsr:@libs/xml@8/parse`. El import map se conserva en
`deno.json` porque las herramientas locales lo siguen usando, pero no es
la fuente de verdad para el deploy.

**4. `supabase db reset` y `supabase status` piden Docker.**

Son comandos de desarrollo local. Contra un proyecto hospedado no sirven —
`db reset` en particular no es lo que quieres. Para inspeccionar el estado
remoto usa el SQL Editor del dashboard.

**5. Editar archivos con acentos desde PowerShell los corrompe.**

`Get-Content`/`Set-Content` en PowerShell 5.1 leen archivos UTF-8 sin BOM
usando el codepage ANSI del sistema, y al reescribirlos dejan cada acento
doble-codificado (`verificación` → `verificaciÃ³n`). Este proyecto está
escrito íntegramente en español, comentarios incluidos, así que **las
ediciones masivas van por Python con `encoding='utf-8'` explícito**, nunca
por cmdlets de PowerShell. (Pasó dos veces en este repo antes de quedar
anotado aquí.)

## Verificado en producción

Desplegado en el proyecto `smocemszqzsypuachevr` y **ejercitado contra los
servicios reales** (Meta, OpenAI, Postgres), no solo contra tests:

| Flujo | Cómo se verificó |
|---|---|
| `auth-register` → `auth-login` → `auth-refresh` | HTTP real; devuelve access + refresh token |
| `auth-register` con email repetido | responde `400`, o sea que contesta nuestro chequeo y no solo el `UNIQUE` de Postgres |
| `api-user-profile`, `api-summary`, `api-invoices` | HTTP real con JWT propio |
| `api-invoices/{id}/reclassify` | cambia la categoría, pone `confianza = 1.0`, y el resumen refleja el cambio |
| Aislamiento entre usuarios | reclasificar una factura ajena → `404`; sin token → `401` |
| Rate limiting de `/auth/login` (M8) | 5 intentos → `401`; del 6º en adelante → `429` con `Retry-After`; tras 62s la ventana se libera |
| `api-chat` | respuesta de OpenAI con `tools_used: [explain_deductions]` |
| `api-public-summary` / `api-public-invoices` | con `web_token` válido → `200`; con token inválido → `404` |
| Webhook de SendGrid, JSON | XML real en base64; decodificado, clasificado y guardado |
| Webhook de SendGrid, `multipart/form-data` (M9) | el formato real de Inbound Parse; resultado **idéntico** al de JSON — mismo UUID, misma categoría, mismos hallazgos. Sin adjuntos → `202 sin_adjuntos` |
| Verificación de origen de SendGrid (M10) | sin credenciales, con Basic auth incorrecto y con query param incorrecto → `401`; con el secreto correcto por cualquiera de las dos vías → `200` |
| **Correo real de punta a punta** | factura real enviada por correo a `facturas.<dominio>`, entregada por SendGrid Inbound Parse vía MX, parseada y guardada. Emisor no deducible → `Sin clasificar`, que es el resultado correcto |
| WhatsApp: comando rápido (`hola`) | mensaje real desde un teléfono; responde sin llamar a OpenAI |
| WhatsApp: chat conversacional (M4b) | mensaje real; `tools_used: [get_summary]`, leyendo de Postgres |
| WhatsApp: ingesta de factura | XML real como adjunto; descargado de la Graph API, parseado, validado, clasificado y guardado |
| WhatsApp: reglas del validador | los 4 CFDI de `testdata/` — válido, pago en efectivo, RFC ajeno y duplicado — dan el resultado esperado cada uno |

Dos renglones valen una nota:

**La ingesta por WhatsApp** es la que cierra el producto: ejercita
`downloadMediaFromMeta` (las dos llamadas a la Graph API), que ningún test
puede cubrir porque requiere un `media_id` que solo Meta genera.

**La interoperabilidad bcrypt quedó confirmada contra el servicio real**, no
solo en tests: se generó un hash con el `bcrypt` de Python, se guardó en la
BD, y `auth-login` lo verificó con `bcryptjs` en Deno. Es la pieza que
permite que las versiones Python y Supabase compartan la tabla de usuarios
durante la transición.

### Configuración de Meta que no es evidente

Para que Meta entregue los mensajes hacen falta **tres** cosas en lugares
distintos, y las dos primeras se ven completas en la consola aunque la
tercera falte:

1. Callback URL + verify token → en la app
2. Campo `messages` suscrito → en la app
3. **La app suscrita a la WABA** → en la cuenta de WhatsApp

La tercera es la que decide realmente el enrutamiento y solo se ve por la
Graph API. En este proyecto estaba apuntando a `WA DevX Webhook Events 1P
App` (la app interna de pruebas de Meta), así que los mensajes nunca
llegaban al webhook pese a que todo lo demás estaba bien:

```bash
# Ver a qué apps entrega la WABA
curl "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<TOKEN>"

# Suscribir la app dueña del token
curl -X POST "https://graph.facebook.com/v21.0/<WABA_ID>/subscribed_apps?access_token=<TOKEN>"
```

El `WHATSAPP_ACCESS_TOKEN` debe ser de un **System User** con caducidad
*Nunca* (Business Settings → Usuarios del sistema), con la app y la WABA
asignadas como activos. El token temporal de 24h que ofrece la consola de
desarrollo no sirve para nada persistente.

Con el número de prueba de Meta, además, solo se puede conversar con los
números registrados explícitamente como destinatarios (máximo 5).

## Qué NO se hizo todavía

- ❌ **`/health`, `/privacy`, `/a/{token}` (páginas HTML)** — son páginas,
  no API; fuera del alcance de esta migración.
- ⚠️ **El canal de correo funciona, pero el dominio configurado es de
  prueba.** Al mover el sistema a su dominio definitivo hay que cambiar el
  registro MX y el *Receiving Domain* en Inbound Parse. El código no se
  toca, y como el subdominio es independiente, ambos pueden convivir
  durante la transición.
- ⚠️ **La verificación de origen de SendGrid autentica el ORIGEN, no el
  CONTENIDO.** Inbound Parse no firma sus peticiones (a diferencia de Meta),
  así que quien tenga el secreto puede enviar el correo que quiera. Es
  estrictamente mejor que no tener nada, pero no equivale al HMAC de
  WhatsApp, que además prueba que el cuerpo no fue alterado.
- ⚠️ **La verificación se omite si `SENDGRID_WEBHOOK_SECRET` no está
  configurado** (avisando en el log), para no tumbar un despliegue en
  funcionamiento al introducirla. Eso significa que **un despliegue nuevo
  queda desprotegido hasta que se configure el secreto** — pasó exactamente
  eso al desplegar M10, y solo se detectó porque la verificación contra
  producción lo mostró.
- ✅ **No hay datos de producción que migrar** — comprobado, no supuesto.
  Ver "Por qué no hubo migración de datos" más abajo.
- ❌ **Sin respuesta por email en SendGrid** (fuera de alcance de v1, igual
  que en `ingest_email_sendgrid()` — Python tampoco responde por correo).
- ⚠️ **El corte de WhatsApp ya ocurrió de hecho, aunque Railway siga
  encendido.** El Callback URL de Meta apunta a
  `.../functions/v1/whatsapp-webhook` y la WABA está suscrita a FactuApp,
  así que todo el tráfico de WhatsApp llega a Supabase y Railway recibe
  cero. Apagar el proyecto Python es ya un trámite, no una migración.
- ❌ **No se corrigieron los hallazgos del lado Python** (campo
  `whatsapp_token` vs. `.env` con `WHATSAPP_ACCESS_TOKEN`; falta
  `WHATSAPP_APP_SECRET`) — fuera del alcance de esta migración, pero valen
  la pena si el webhook en Railway no responde como se espera.

### Límite conocido de la suite de tests

Los 119 tests corren sobre **Deno local**, y el runtime de Supabase Edge
Functions no es idéntico. `Buffer` existe como global en el primero pero no
en el segundo, y eso dejó pasar un `ReferenceError` a producción con los
tests en verde — en `whatsapp.ts` (firma HMAC) y en `email.ts` (adjuntos de
SendGrid) a la vez.

De ahí el criterio para `_shared/`: **usar estándares web** (`atob`,
`TextEncoder`, `crypto.subtle`) en vez de APIs de Node. Si algo realmente
necesita `node:`, hay que probarlo contra el entorno desplegado antes de
darlo por bueno — y ojo, importar explícitamente de `node:buffer` **no**
funciona: el import falla al cargar el módulo y tumba la función entera,
incluido el handshake GET.
