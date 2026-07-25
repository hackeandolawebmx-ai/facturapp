"""Esquemas Pydantic para requests/responses (Fase 2a/3a)."""
from __future__ import annotations

import re

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

# RFC persona física: exactamente 13 caracteres alfanuméricos
# (4 letras + 6 dígitos de fecha + 3 alfanuméricos de homoclave).
_RFC_RE = re.compile(r"^[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}$")


class UserRegister(BaseModel):
    email: EmailStr
    nombre: str = Field(min_length=1, max_length=255)
    rfc: str
    password: str = Field(min_length=8, max_length=128)

    @field_validator("rfc")
    @classmethod
    def validar_rfc(cls, v: str) -> str:
        v = v.strip().upper()
        if len(v) != 13:
            raise ValueError("RFC debe tener exactamente 13 caracteres")
        if not _RFC_RE.match(v):
            raise ValueError("RFC debe tener 13 caracteres alfanuméricos (formato: AAAA000000XXX)")
        return v


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str | None = None
    token_type: str = "bearer"
    expires_in: int | None = None  # segundos hasta que expira access_token
    user_id: int


class UserProfile(BaseModel):
    id: int
    email: EmailStr
    nombre: str
    rfc: str
    plan: str
    web_token: str | None = None
    whatsapp_phone: str | None = None


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=2000)


class ChatResponse(BaseModel):
    response: str
    tools_used: list[str] = []


# ---- Email inbound (Fase 3a, webhook SendGrid) ---------------------------

class EmailAttachment(BaseModel):
    filename: str
    content: str  # base64


class EmailWebhook(BaseModel):
    """Payload del webhook de SendGrid.

    NOTA: SendGrid Inbound Parse en producción envía multipart/form-data
    (no JSON) — este esquema asume un adaptador/relay que normaliza el
    correo a JSON con adjuntos en base64 antes de llegar aquí. Ver
    email_service.py y el README para el detalle.
    """
    model_config = ConfigDict(populate_by_name=True)

    from_: str = Field(alias="from")
    to: str
    subject: str | None = None
    attachments: list[EmailAttachment] = Field(default_factory=list)


# ---- WhatsApp inbound (Fase 3b, webhook Meta Cloud API) -------------------

class WhatsAppWebhookPayload(BaseModel):
    """Payload crudo del webhook de Meta.

    Deliberadamente laxo (`entry: list[dict]`): la forma exacta de `changes`
    varía mucho según el tipo de evento (mensaje, status, etc.), así que la
    validación fina de mensajes vive en whatsapp_service.extract_whatsapp_messages,
    no aquí.
    """
    object: str | None = None
    entry: list[dict] = Field(default_factory=list)
