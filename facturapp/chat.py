"""Chat conversacional con OpenAI (function calling) — Fase 2a.

Diseño:
- `classify_intent`: heurística determinística (5 intenciones) — testeable offline.
- Herramientas (tools) tipadas que consultan la BD SIEMPRE filtrando por user_id
  (zero-trust): cada usuario solo ve sus propias facturas.
- `chat()`: orquesta el loop de function calling. La llamada al LLM vive en
  `_chat_completion`, fácil de mockear en tests (no gasta API).
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass

from openai import APIError, OpenAIError, RateLimitError
from sqlalchemy.orm import Session

from .config import settings
from .export import export_zip
from .models import Invoice, User
from .schemas import ChatResponse

logger = logging.getLogger("facturapp.chat")


class ChatServiceError(Exception):
    """Error de cara al usuario cuando falla la llamada al LLM (OpenAI)."""

    def __init__(self, user_message: str):
        self.user_message = user_message
        super().__init__(user_message)


class ChatIntent:
    RESUMEN = "obtener_resumen"
    LISTAR = "listar_facturas"
    RECLASIFICAR = "reclasificar"
    EXPORTAR = "exportar"
    AYUDA = "solicitar_ayuda"


# Palabras clave por intención (orden = prioridad).
_INTENT_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    (ChatIntent.RECLASIFICAR, ("reclasif", "cambia", "corrige", "es de", "muévela", "muevela")),
    (ChatIntent.EXPORTAR, ("exporta", "descarga", "zip", "excel", "paquete")),
    (ChatIntent.LISTAR, ("factura", "lista", "muestra", "enséñame", "ensename", "ver mis", "de marzo", "de julio")),
    (ChatIntent.RESUMEN, ("cuánto", "cuanto", "resumen", "total", "llevo", "cédula", "cedula", "deducible")),
    (ChatIntent.AYUDA, ("qué puedo", "que puedo", "ayuda", "cómo", "como", "deducir", "explica")),
]


def classify_intent(message: str) -> str:
    """Detecta la intención principal por palabras clave (determinístico)."""
    text = message.lower()
    for intent, keywords in _INTENT_KEYWORDS:
        if any(k in text for k in keywords):
            return intent
    return ChatIntent.AYUDA


# --------------------------------------------------------------------------
# Herramientas (function calling) — esquema OpenAI
# --------------------------------------------------------------------------

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_summary",
            "description": "Obtiene totales de deducciones por categoría del usuario.",
            "parameters": {
                "type": "object",
                "properties": {
                    "year": {"type": "integer"},
                    "categoria": {"type": "string"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_invoices",
            "description": "Lista facturas del usuario con filtros opcionales.",
            "parameters": {
                "type": "object",
                "properties": {
                    "year": {"type": "integer"},
                    "month": {"type": "integer"},
                    "categoria": {"type": "string"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reclassify_invoice",
            "description": "Reclasifica una factura del usuario a otra categoría.",
            "parameters": {
                "type": "object",
                "properties": {
                    "uuid": {"type": "string"},
                    "nueva_categoria": {"type": "string"},
                },
                "required": ["uuid", "nueva_categoria"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "export_package",
            "description": "Genera un paquete ZIP de exportación del año.",
            "parameters": {
                "type": "object",
                "properties": {"year": {"type": "integer"}},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "explain_deductions",
            "description": "Explica las categorías de deducción disponibles.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]

_CATEGORIAS_INFO = {
    "Médicos": "Gastos médicos, dentales y hospitalarios con pago electrónico y emisor colegiado.",
    "Colegiaturas": "Colegiaturas de nivel preescolar a bachillerato, con tope anual por nivel.",
    "Seguros GMM": "Primas de seguros de gastos médicos mayores.",
    "Hipoteca": "Intereses reales de créditos hipotecarios (constancia anual del banco).",
}


# --------------------------------------------------------------------------
# Ejecución de herramientas (SIEMPRE filtra por user.id)
# --------------------------------------------------------------------------

def tool_get_summary(db: Session, user: User, year: int | None = None,
                     categoria: str | None = None) -> dict:
    year = year or settings.year_default
    q = db.query(Invoice).filter(Invoice.user_id == user.id, Invoice.anio == year)
    if categoria:
        q = q.filter(Invoice.categoria == categoria)
    cedula: dict[str, dict] = {}
    total_general = 0.0
    for r in q.all():
        cat = r.categoria or "Sin clasificar"
        e = cedula.setdefault(cat, {"total": 0.0, "facturas": 0})
        e["total"] = round(e["total"] + (r.total or 0.0), 2)
        e["facturas"] += 1
        total_general = round(total_general + (r.total or 0.0), 2)
    return {"year": year, "categorias": cedula, "total_general": total_general}


def tool_list_invoices(db: Session, user: User, year: int | None = None,
                       month: int | None = None, categoria: str | None = None) -> dict:
    year = year or settings.year_default
    q = db.query(Invoice).filter(Invoice.user_id == user.id, Invoice.anio == year)
    if categoria:
        q = q.filter(Invoice.categoria == categoria)
    rows = q.order_by(Invoice.fecha_emision.desc()).all()
    if month:
        mm = f"{month:02d}"
        rows = [r for r in rows if (r.fecha_emision or "")[5:7] == mm]
    return {
        "year": year,
        "count": len(rows),
        "invoices": [
            {"uuid": r.uuid_fiscal, "emisor": r.emisor_nombre, "fecha": r.fecha_emision,
             "categoria": r.categoria, "total": r.total, "estatus": r.estatus}
            for r in rows
        ],
    }


def tool_reclassify_invoice(db: Session, user: User, uuid: str,
                            nueva_categoria: str) -> dict:
    inv = (
        db.query(Invoice)
        .filter(Invoice.user_id == user.id, Invoice.uuid_fiscal == uuid.upper())
        .first()
    )
    if inv is None:
        return {"ok": False, "mensaje": "No encontré esa factura en tu archivo."}
    anterior = inv.categoria
    inv.categoria = nueva_categoria
    inv.confianza = 1.0
    db.commit()
    return {"ok": True, "uuid": uuid, "de": anterior, "a": nueva_categoria}


def tool_export_package(db: Session, user: User, year: int | None = None) -> dict:
    year = year or settings.year_default
    rows = db.query(Invoice).filter(
        Invoice.user_id == user.id, Invoice.anio == year
    ).all()
    return export_zip([r.to_dict() for r in rows])


def tool_explain_deductions() -> dict:
    return {"categorias": _CATEGORIAS_INFO}


def _execute_tool(name: str, db: Session, user: User, args: dict) -> dict:
    if name == "get_summary":
        return tool_get_summary(db, user, args.get("year"), args.get("categoria"))
    if name == "list_invoices":
        return tool_list_invoices(db, user, args.get("year"), args.get("month"), args.get("categoria"))
    if name == "reclassify_invoice":
        return tool_reclassify_invoice(db, user, args.get("uuid", ""), args.get("nueva_categoria", ""))
    if name == "export_package":
        return tool_export_package(db, user, args.get("year"))
    if name == "explain_deductions":
        return tool_explain_deductions()
    return {"error": f"herramienta desconocida: {name}"}


# --------------------------------------------------------------------------
# LLM (OpenAI) — aislado para poder mockearlo en tests
# --------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "Eres el asistente de FacturasMX, una plataforma mexicana de deducciones "
    "fiscales (CFDI 4.0). Responde SIEMPRE en español, claro y accionable. "
    "Usa las herramientas disponibles para consultar los datos reales del "
    "usuario antes de responder con montos o listas. No inventes cifras."
)


@dataclass
class _LLMMessage:
    """Forma mínima de un mensaje del LLM (compatible con OpenAI y con mocks)."""
    content: str | None = None
    tool_calls: list | None = None


def _get_client():
    from openai import OpenAI

    return OpenAI(api_key=settings.openai_api_key)


def _chat_completion(messages: list[dict], tools: list) -> _LLMMessage:
    """Llama a OpenAI. Los tests monkeypatchean esta función.

    Traduce errores de OpenAI a ChatServiceError con un mensaje legible para
    el usuario (nunca expone tracebacks) y registra el detalle técnico.
    """
    client = _get_client()
    try:
        resp = client.chat.completions.create(
            model=settings.openai_model,
            messages=messages,
            tools=tools,
            tool_choice="auto",
        )
    except RateLimitError as exc:
        logger.warning("OpenAI rate limit: %s", exc)
        raise ChatServiceError(
            "Estoy un poco ocupado en este momento. Intenta de nuevo en unos segundos."
        ) from exc
    except APIError as exc:
        logger.error("OpenAI APIError: %s", exc)
        raise ChatServiceError(
            "Tengo problemas para conectarme con el asistente. Intenta más tarde."
        ) from exc
    except OpenAIError as exc:
        logger.error("OpenAI error inesperado: %s", exc)
        raise ChatServiceError(
            "Algo salió mal procesando tu mensaje. Intenta de nuevo."
        ) from exc
    return resp.choices[0].message


# --------------------------------------------------------------------------
# Orquestador
# --------------------------------------------------------------------------

def chat(db: Session, user: User, message: str) -> ChatResponse:
    messages: list[dict] = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": message},
    ]
    tools_used: list[str] = []

    try:
        first = _chat_completion(messages, TOOLS)
        tool_calls = getattr(first, "tool_calls", None)

        if not tool_calls:
            return ChatResponse(response=first.content or "", tools_used=tools_used)

        # Reconstruye el turno del asistente con sus tool_calls (formato OpenAI).
        messages.append({
            "role": "assistant",
            "content": first.content,
            "tool_calls": [
                {"id": tc.id, "type": "function",
                 "function": {"name": tc.function.name, "arguments": tc.function.arguments}}
                for tc in tool_calls
            ],
        })

        for tc in tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            result = _execute_tool(name, db, user, args)
            tools_used.append(name)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result, ensure_ascii=False),
            })

        final = _chat_completion(messages, TOOLS)
        return ChatResponse(response=final.content or "", tools_used=tools_used)
    except ChatServiceError as exc:
        return ChatResponse(response=exc.user_message, tools_used=[])
