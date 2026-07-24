# FacturasMX — Fase 2b

Plataforma que consolida y valida facturas mexicanas (**CFDI 4.0**) para
deducciones anuales. **Fase 2a** convirtió el MVP en un producto multiusuario
(Supabase + JWT + chat con OpenAI); **Fase 2b** endurece la seguridad antes de
conectar a Supabase en producción: rate limiting, refresh tokens, RFC estricto,
manejo de errores de OpenAI y logging a archivo.

El **parser, validador y clasificador de Fase 1 no cambiaron** — solo se
agregaron capas de auth, persistencia real, chat y seguridad encima.

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

**62 tests en verde** (41 de Fase 2a + 21 de Fase 2b). Corren offline: BD
SQLite en-memory, el LLM mockeado y el rate limiter reseteado por test (no
gastan API de OpenAI ni tocan Supabase).

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
| POST | `/webhooks/email` | Bearer | Ingesta CFDI/PDF (por usuario) |
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
├── schemas.py       # Pydantic (register/login/token/chat)
├── parser.py · validator.py · classifier.py   # Fase 1, SIN cambios
├── export.py        # ZIP/Excel (mock)
├── templates/dashboard.html
├── seeds/           # 4 CFDI + usuarios-test.sql
└── tests/           # 62 tests (offline)
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

## Qué viene

- Conectar a Supabase real con las credenciales de producción.
- **Fase 2c:** ingesta real de correo (SendGrid inbound).
- **Fase 3:** WhatsApp + Paquete Abril (monetización).
- **Fase 4:** export Excel/ZIP funcional.
