"""Ingesta de facturas por WhatsApp (Fase 3b) — Meta Cloud API.

Cuatro responsabilidades separadas del endpoint (main.py):
- Verificar la firma HMAC del webhook (X-Hub-Signature-256).
- Extraer los mensajes con documento adjunto del payload de Meta.
- Descargar el adjunto real desde la Graph API (dos pasos: media_id → URL
  temporal → bytes).
- Resolver el usuario dueño de la factura a partir del teléfono, creando una
  cuenta mínima si no está registrado (igual que email_service.py).
- Enviar la respuesta de vuelta al usuario por WhatsApp.

⚠️ Nota importante (difiere del payload "de juguete" típico en tutoriales):
Meta NO manda una URL descargable en el webhook — solo `document.id` (media
ID). Hay que resolverlo vía Graph API con el access token, en dos llamadas.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets

import httpx
from sqlalchemy.orm import Session

from .accounts import placeholder_rfc
from .auth import generate_web_token, hash_password
from .models import User
from .schemas import WhatsAppWebhookPayload

logger = logging.getLogger(__name__)

_GRAPH_API_BASE = "https://graph.facebook.com/v19.0"


# --------------------------------------------------------------------------
# Verificación de firma (POST /webhooks/whatsapp)
# --------------------------------------------------------------------------

def verify_whatsapp_signature(body: bytes, signature_header: str | None, app_secret: str) -> bool:
    """Verifica el header `X-Hub-Signature-256: sha256=<hex>` de Meta.

    IMPORTANTE: `app_secret` es el App Secret de la app de Meta, NO el
    "verify token" usado en el handshake GET — son dos secretos distintos.
    """
    logger.info(f"[VERIFY] Verificando firma HMAC. Header: {signature_header[:20] if signature_header else 'None'}...")
    
    if not signature_header or not signature_header.startswith("sha256="):
        logger.warning("[VERIFY] Header inválido o faltante")
        return False
    
    expected = hmac.new(app_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    provided = signature_header.split("=", 1)[1]
    
    is_valid = hmac.compare_digest(expected, provided)
    logger.info(f"[VERIFY] Firma válida: {is_valid}")
    return is_valid


# --------------------------------------------------------------------------
# Extracción de mensajes del payload de Meta
# --------------------------------------------------------------------------

def extract_whatsapp_messages(payload: WhatsAppWebhookPayload | dict) -> list[dict]:
    """Recorre entry → changes → value → messages y devuelve solo los
    mensajes de tipo "document" con su remitente y media_id.

    Cada resultado: {"from", "media_id", "mime_type", "filename", "profile_name"}.
    """
    logger.info("[EXTRACT] Extrayendo mensajes del payload")
    
    if isinstance(payload, WhatsAppWebhookPayload):
        entries = payload.entry
    else:
        entries = payload.get("entry", [])

    logger.info(f"[EXTRACT] Total entries: {len(entries)}")

    results: list[dict] = []
    for entry in entries:
        for change in entry.get("changes", []):
            value = change.get("value", {})
            contacts = value.get("contacts", [])
            profile_names = {
                c.get("wa_id"): c.get("profile", {}).get("name") for c in contacts
            }
            messages = value.get("messages", [])
            logger.info(f"[EXTRACT] Mensajes en este change: {len(messages)}")
            
            for msg in messages:
                msg_type = msg.get("type")
                logger.info(f"[EXTRACT] Tipo de mensaje: {msg_type}")
                
                if msg_type != "document":
                    logger.debug(f"[EXTRACT] Ignorando mensaje de tipo {msg_type}")
                    continue
                
                document = msg.get("document", {})
                media_id = document.get("id")
                if not media_id:
                    logger.warning("[EXTRACT] Documento sin media_id")
                    continue
                
                phone = msg.get("from", "")
                filename = document.get("filename") or "factura"
                
                result = {
                    "from": phone,
                    "media_id": media_id,
                    "mime_type": document.get("mime_type", ""),
                    "filename": filename,
                    "profile_name": profile_names.get(phone),
                }
                logger.info(f"[EXTRACT] Documento capturado: {filename} (id={media_id[:20]}...) from {phone}")
                results.append(result)
    
    logger.info(f"[EXTRACT] Total documentos extraídos: {len(results)}")
    return results


# --------------------------------------------------------------------------
# Graph API: descargar media (dos pasos) y enviar mensajes
# --------------------------------------------------------------------------

async def download_media_from_meta(media_id: str, token: str) -> tuple[bytes, str]:
    """Descarga el contenido de un adjunto de WhatsApp.

    Meta requiere DOS llamadas: (1) resolver el media_id a una URL temporal
    de descarga, (2) descargar esa URL — ambas con el mismo Bearer token.
    """
    logger.info(f"[DOWNLOAD] Iniciando descarga de media {media_id[:20]}...")
    
    headers = {"Authorization": f"Bearer {token[:10]}..."}  # Log sin exponer token completo
    
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            logger.info(f"[DOWNLOAD] Paso 1: Obtener URL de {_GRAPH_API_BASE}/{media_id}")
            meta_resp = await client.get(f"{_GRAPH_API_BASE}/{media_id}", headers=headers)
            meta_resp.raise_for_status()
            media_info = meta_resp.json()
            logger.info(f"[DOWNLOAD] Paso 1 OK. URL resuelto")

            download_url = media_info.get("url", "")
            logger.info(f"[DOWNLOAD] Paso 2: Descargar desde URL")
            content_resp = await client.get(download_url, headers=headers)
            content_resp.raise_for_status()
            
            content = content_resp.content
            mime_type = media_info.get("mime_type", "")
            
            logger.info(f"[DOWNLOAD] Descarga completada: {len(content)} bytes, {mime_type}")
            return content, mime_type
    
    except Exception as e:
        logger.error(f"[DOWNLOAD] Error descargando media: {type(e).__name__}: {e}")
        raise


async def send_whatsapp_message(phone: str, message: str, token: str, phone_number_id: str) -> dict:
    """Envía un mensaje de texto de vuelta al usuario vía Graph API."""
    logger.info(f"[SEND] Enviando mensaje a {phone}")
    
    url = f"{_GRAPH_API_BASE}/{phone_number_id}/messages"
    headers = {"Authorization": f"Bearer {token[:10]}..."}  # Log sin exponer token
    body = {
        "messaging_product": "whatsapp",
        "to": phone,
        "type": "text",
        "text": {"body": message},
    }
    
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, headers=headers, json=body)
            resp.raise_for_status()
            result = resp.json()
            logger.info(f"[SEND] Mensaje enviado exitosamente. ID: {result.get('messages', [{}])[0].get('id', 'N/A')}")
            return result
    
    except Exception as e:
        logger.error(f"[SEND] Error enviando mensaje: {type(e).__name__}: {e}")
        raise


# --------------------------------------------------------------------------
# Resolución de usuario por teléfono
# --------------------------------------------------------------------------

def _placeholder_email_for_phone(phone: str) -> str:
    return f"wa-{phone}@facturapp.mx"


def get_or_create_user_by_phone(db: Session, phone: str, profile_name: str | None = None) -> User:
    """Busca al usuario por teléfono de WhatsApp; si no existe, crea una
    cuenta mínima (mismo patrón que get_or_create_user_by_email)."""
    logger.info(f"[USER] Buscando usuario por teléfono: {phone}")
    
    phone = phone.strip()
    user = db.query(User).filter(User.whatsapp_phone == phone).first()
    
    if user is not None:
        logger.info(f"[USER] Usuario encontrado: {user.id} ({user.email})")
        return user

    logger.info(f"[USER] Usuario no encontrado. Creando cuenta mínima")
    email = _placeholder_email_for_phone(phone)
    user = User(
        email=email,
        nombre=profile_name or phone,
        rfc=placeholder_rfc(phone),
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        web_token=generate_web_token(),
        whatsapp_phone=phone,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    logger.info(f"[USER] Cuenta creada: {user.id} ({email})")
    return user