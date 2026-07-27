# FacturasMX — Migración a Supabase (Fase M6)

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
| **M6** | Migrar datos existentes de SQLite a este esquema | ✅ Este documento (ver caveat sobre datos de prueba) |

## Estructura

```
supabase/
├── functions/
│   ├── whatsapp-webhook/index.ts   # GET + POST completos (Fase M4)
│   ├── sendgrid-webhook/index.ts   # POST completo (Fase M5)
│   ├── api-chat/index.ts           # POST autenticado, JWT Bearer (Fase M5.5)
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
│       ├── chat.ts                 # port de chat.py — classifyIntent, TOOLS, chat() orquestador (Fase M5.5)
│       ├── chat.test.ts            # 13 tests
│       ├── fake_supabase_client.ts # cliente Supabase FALSO solo para tests — no es Postgres real (select/insert/update/order)
│       └── testdata/               # los mismos 4 XML de seed de Fase 1
├── migrations/
│   └── 0001_initial_schema.sql     # esquema `facturapp` (users, invoices, chat_messages)
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
supabase secrets set SECRET_KEY=...             # mismo valor que en Railway/Python — firma los JWT que api-chat verifica
supabase secrets set WHATSAPP_ACCESS_TOKEN=...
supabase secrets set WHATSAPP_PHONE_NUMBER_ID=...
supabase secrets set WHATSAPP_VERIFY_TOKEN=...
supabase secrets set WHATSAPP_APP_SECRET=...
```

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

**Con Supabase CLI** (recomendado, requiere login interactivo):

```bash
npm install -g supabase   # o scoop/homebrew, según tu SO
supabase login
supabase link --project-ref <tu-project-ref>
supabase db push
supabase functions deploy whatsapp-webhook
supabase functions deploy sendgrid-webhook
```

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

## Qué NO se hizo todavía (por diseño)

- ❌ Los webhooks de WhatsApp (M4), SendGrid (M5), el endpoint `/api/chat`
  (M5.5) y la migración de datos (M6) están completos — toda la lógica
  funcional del sistema Python está portada.
- ❌ **La migración de datos (M6) solo cubrió los datos de prueba presentes
  en `facturapp.db` local** (2 usuarios `@example.com`, 0 facturas, 0
  chats). Si la producción real vive en un SQLite distinto (volumen de
  Railway), esa migración real todavía no se hizo.
- ❌ **`0002_seed_test_users.sql` no se aplicó** — está generado para que tú
  lo revises y corras en el SQL Editor de Supabase (o vía `supabase db
  push`).
- ❌ **Sin respuesta por email en SendGrid** (explícitamente fuera de
  alcance de v1, igual que en `ingest_email_sendgrid()` — Python tampoco
  responde por correo hoy).
- ❌ **Sin verificación de origen en el webhook de SendGrid** — mismo
  caveat que la versión Python: no valida que la petición venga
  realmente de SendGrid.
- ❌ No se migraron datos existentes (Fase M6).
- ❌ No se tocó el proyecto Railway/Python — sigue siendo el fallback hasta
  confirmar en vivo que la versión Supabase funciona igual o mejor. No se
  cambió el Callback URL en Meta todavía.
- ❌ **No se desplegó nada a Supabase.** Sin `supabase login` (OAuth
  interactivo) no hay forma de hacer `supabase functions deploy` ni
  `supabase db push` desde aquí — el deploy y el smoke test real con un
  mensaje de WhatsApp real quedan para que tú los corras (ver comandos en
  "Aplicar la migración" arriba).
- ❌ **No se envió ningún mensaje de WhatsApp real.** `sendWhatsappMessage`
  está implementado y cubierto por tests contra un cliente simulado, pero
  no se probó contra la API real — a diferencia de la descarga (una
  lectura sin efectos secundarios), enviar notificaría a un número real.
  Eso requiere que tú lo autorices explícitamente con un número de
  destino.
- ❌ **No se corrigieron los hallazgos del lado Python** (campo
  `whatsapp_token` vs. `.env` con `WHATSAPP_ACCESS_TOKEN`; falta
  `WHATSAPP_APP_SECRET`; token de WhatsApp expirado) — están fuera del
  alcance de esta migración ("no tocar Railway/Python"), pero valen la
  pena revisarlos independientemente si el webhook de WhatsApp en Railway
  no está respondiendo como se espera.
