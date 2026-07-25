"""Ingesta de facturas por correo (Fase 3a) — SendGrid Inbound Parse.

Dos responsabilidades separadas del endpoint (main.py):
- Extraer y clasificar adjuntos (XML/PDF) de un EmailWebhook.
- Resolver el usuario dueño de la factura a partir del remitente, creando
  una cuenta mínima si el correo no está registrado (el usuario reenvía
  antes de completar su registro; puede completar su perfil después).
"""
from __future__ import annotations

import base64
import re
import secrets

from sqlalchemy.orm import Session

from .accounts import placeholder_rfc
from .auth import generate_web_token, hash_password
from .models import User
from .schemas import EmailWebhook

_EMAIL_IN_BRACKETS_RE = re.compile(r"<([^<>]+)>")


def extract_sender_email(raw_from: str) -> str:
    """Extrae la dirección de un remitente tipo `"Nombre" <correo@dominio.com>`.

    Si no hay `<...>`, asume que `raw_from` ya es la dirección pura.
    """
    match = _EMAIL_IN_BRACKETS_RE.search(raw_from)
    address = match.group(1) if match else raw_from
    return address.strip().lower()


def extract_attachments(webhook: EmailWebhook) -> dict[str, bytes]:
    """Decodifica los adjuntos base64 y los clasifica por tipo (xml/pdf).

    Devuelve como máximo un adjunto por tipo: si el correo trae varios del
    mismo tipo, se queda con el último (caso raro — la mayoría de los
    correos reenviados traen un único CFDI). Adjuntos que no decodifican
    como base64 válido se ignoran silenciosamente.
    """
    result: dict[str, bytes] = {}
    for att in webhook.attachments:
        name = att.filename.lower()
        try:
            content = base64.b64decode(att.content, validate=True)
        except (ValueError, TypeError):
            continue
        if name.endswith(".xml"):
            result["xml"] = content
        elif name.endswith(".pdf"):
            result["pdf"] = content
    return result


def get_or_create_user_by_email(db: Session, email: str) -> User:
    """Busca al usuario por email; si no existe, crea una cuenta mínima.

    La cuenta auto-creada recibe una contraseña aleatoria e inutilizable
    (nadie la conoce) — no habilita login directo, solo permite asociar
    facturas al correo hasta que el usuario complete su registro real.
    """
    email = email.strip().lower()
    user = db.query(User).filter(User.email == email).first()
    if user is not None:
        return user

    user = User(
        email=email,
        nombre=email.split("@")[0],
        rfc=placeholder_rfc(email),
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        web_token=generate_web_token(),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user
