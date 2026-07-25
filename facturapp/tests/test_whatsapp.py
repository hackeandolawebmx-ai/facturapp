"""Tests del webhook de WhatsApp (Fase 3b, Meta Cloud API).

Las llamadas reales a la Graph API (descargar media, enviar mensajes) se
mockean vía monkeypatch sobre `facturapp.main` (los nombres se importaron
directo ahí, no vía `whatsapp_service.func()`, así que el monkeypatch debe
apuntar al módulo que realmente los invoca).
"""
import hashlib
import hmac
import json

from facturapp import main as main_module
from facturapp.config import settings
from facturapp.database import SessionLocal
from facturapp.models import Invoice, User
from facturapp.whatsapp_service import (
    extract_whatsapp_messages, get_or_create_user_by_phone, verify_whatsapp_signature,
)


def _signed_post(client, url: str, payload_dict: dict):
    """Serializa el payload UNA vez, firma esos bytes exactos, y los manda
    tal cual (usar json= dejaría que httpx re-serialice y la firma no
    coincidiría con lo que realmente se envía)."""
    body = json.dumps(payload_dict).encode("utf-8")
    sig = hmac.new(settings.whatsapp_app_secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return client.post(url, content=body, headers={
        "Content-Type": "application/json",
        "X-Hub-Signature-256": f"sha256={sig}",
    })


def _meta_document_payload(phone: str, media_id: str = "MEDIA123",
                           mime_type: str = "text/xml", filename: str = "factura.xml",
                           profile_name: str | None = None) -> dict:
    contact = {"wa_id": phone}
    if profile_name:
        contact["profile"] = {"name": profile_name}
    return {
        "object": "whatsapp_business_account",
        "entry": [{
            "id": "WABA_ID",
            "changes": [{
                "field": "messages",
                "value": {
                    "messaging_product": "whatsapp",
                    "contacts": [contact],
                    "messages": [{
                        "from": phone, "id": "wamid.XXX", "type": "document",
                        "document": {"id": media_id, "mime_type": mime_type, "filename": filename},
                    }],
                },
            }],
        }],
    }


# ---- Verificación de firma (unit) ------------------------------------------

def test_verify_whatsapp_signature_valid():
    body = b'{"a": 1}'
    secret = "shhh"
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_whatsapp_signature(body, sig, secret) is True


def test_verify_whatsapp_signature_invalid():
    assert verify_whatsapp_signature(b'{"a": 1}', "sha256=deadbeef", "shhh") is False


def test_verify_whatsapp_signature_missing_header():
    assert verify_whatsapp_signature(b"{}", None, "shhh") is False


def test_verify_whatsapp_signature_wrong_scheme():
    assert verify_whatsapp_signature(b"{}", "plain=abc", "shhh") is False


# ---- Extracción de mensajes (unit) -----------------------------------------

def test_extract_whatsapp_messages_parses_document():
    payload = _meta_document_payload("5511111111111", media_id="M9", filename="f.pdf")
    messages = extract_whatsapp_messages(payload)
    assert len(messages) == 1
    assert messages[0]["media_id"] == "M9"
    assert messages[0]["filename"] == "f.pdf"
    assert messages[0]["from"] == "5511111111111"


def test_extract_whatsapp_messages_ignores_non_document():
    payload = {
        "entry": [{"changes": [{"value": {"messages": [
            {"from": "555", "type": "text", "text": {"body": "hola"}},
        ]}}]}],
    }
    assert extract_whatsapp_messages(payload) == []


def test_extract_whatsapp_messages_uses_profile_name():
    payload = _meta_document_payload("5511111111111", profile_name="Cliente WA")
    messages = extract_whatsapp_messages(payload)
    assert messages[0]["profile_name"] == "Cliente WA"


# ---- get_or_create_user_by_phone (unit) ------------------------------------

def test_get_or_create_user_by_phone_reuses(client):
    db = SessionLocal()
    try:
        u1 = get_or_create_user_by_phone(db, "5522222222222", "Primera Vez")
        u2 = get_or_create_user_by_phone(db, "5522222222222", "Otro Nombre")
        assert u1.id == u2.id
        assert u1.nombre == "Primera Vez"  # el segundo no sobreescribe el nombre
    finally:
        db.close()


# ---- Endpoint GET (handshake de verificación) ------------------------------

def test_whatsapp_webhook_verification_success(client):
    r = client.get("/webhooks/whatsapp", params={
        "hub.mode": "subscribe",
        "hub.verify_token": settings.whatsapp_verify_token,
        "hub.challenge": "12345",
    })
    assert r.status_code == 200
    assert r.text == "12345"


def test_whatsapp_webhook_verification_wrong_token(client):
    r = client.get("/webhooks/whatsapp", params={
        "hub.mode": "subscribe",
        "hub.verify_token": "token-incorrecto",
        "hub.challenge": "12345",
    })
    assert r.status_code == 403


def test_whatsapp_webhook_verification_wrong_mode(client):
    r = client.get("/webhooks/whatsapp", params={
        "hub.mode": "unsubscribe",
        "hub.verify_token": settings.whatsapp_verify_token,
        "hub.challenge": "12345",
    })
    assert r.status_code == 403


# ---- Endpoint POST: firma -------------------------------------------------

def test_whatsapp_webhook_invalid_signature(client):
    payload = _meta_document_payload("5511999999999")
    body = json.dumps(payload).encode("utf-8")
    r = client.post("/webhooks/whatsapp", content=body, headers={
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=" + "0" * 64,
    })
    assert r.status_code == 401


def test_whatsapp_webhook_missing_signature(client):
    payload = _meta_document_payload("5511999999999")
    body = json.dumps(payload).encode("utf-8")
    r = client.post("/webhooks/whatsapp", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 401


# ---- Endpoint POST: flujo completo (media mockeada) ------------------------

def test_whatsapp_webhook_with_document(client, xml_valido, monkeypatch):
    sent = {}

    async def fake_download(media_id, token):
        assert media_id == "MEDIA123"
        assert token == settings.whatsapp_token
        return xml_valido.encode("utf-8"), "text/xml"

    async def fake_send(phone, message, token, phone_number_id):
        sent["phone"] = phone
        sent["message"] = message
        sent["phone_number_id"] = phone_number_id
        return {"messages": [{"id": "wamid.reply"}]}

    monkeypatch.setattr(main_module, "download_media_from_meta", fake_download)
    monkeypatch.setattr(main_module, "send_whatsapp_message", fake_send)

    payload = _meta_document_payload("5511999999999", profile_name="Cliente WA")
    r = _signed_post(client, "/webhooks/whatsapp", payload)
    assert r.status_code == 200

    resultado = r.json()["resultados"][0]
    assert resultado["from"] == "5511999999999"
    # RFC placeholder del usuario auto-creado no coincide con el receptor del
    # CFDI → advertencia RFC_AJENO (mismo comportamiento que en Fase 3a/email).
    assert resultado["estatus"] == "advertencia"

    assert sent["phone"] == "5511999999999"
    assert "problema" not in sent["message"].lower()  # no debe sonar a error interno
    assert sent["phone_number_id"] == settings.whatsapp_phone_number_id

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.whatsapp_phone == "5511999999999").first()
        assert user is not None
        assert user.nombre == "Cliente WA"
        assert user.rfc.startswith("PEND")
        inv = db.query(Invoice).filter(Invoice.user_id == user.id).first()
        assert inv is not None
    finally:
        db.close()


def test_whatsapp_webhook_reuses_existing_user(client, xml_valido, xml_efectivo, monkeypatch):
    async def fake_send(*args, **kwargs):
        return {}
    monkeypatch.setattr(main_module, "send_whatsapp_message", fake_send)

    async def fake_download_1(media_id, token):
        return xml_valido.encode("utf-8"), "text/xml"
    monkeypatch.setattr(main_module, "download_media_from_meta", fake_download_1)
    _signed_post(client, "/webhooks/whatsapp", _meta_document_payload("5599999999999", media_id="M1"))

    async def fake_download_2(media_id, token):
        return xml_efectivo.encode("utf-8"), "text/xml"
    monkeypatch.setattr(main_module, "download_media_from_meta", fake_download_2)
    _signed_post(client, "/webhooks/whatsapp", _meta_document_payload("5599999999999", media_id="M2"))

    db = SessionLocal()
    try:
        users = db.query(User).filter(User.whatsapp_phone == "5599999999999").all()
        assert len(users) == 1
        invoices = db.query(Invoice).filter(Invoice.user_id == users[0].id).all()
        assert len(invoices) == 2
    finally:
        db.close()


def test_whatsapp_webhook_download_failure_does_not_crash(client, monkeypatch):
    async def fake_download_fail(media_id, token):
        raise RuntimeError("network boom")

    async def fake_send(*args, **kwargs):
        return {}

    monkeypatch.setattr(main_module, "download_media_from_meta", fake_download_fail)
    monkeypatch.setattr(main_module, "send_whatsapp_message", fake_send)

    r = _signed_post(client, "/webhooks/whatsapp", _meta_document_payload("5588888888888"))
    assert r.status_code == 200  # nunca 500: el error se registra, no se propaga
    assert "error" in r.json()["resultados"][0]


def test_whatsapp_webhook_send_failure_does_not_crash(client, xml_valido, monkeypatch):
    """Si falla el envío de la respuesta, el procesamiento ya hecho no se pierde."""
    async def fake_download(media_id, token):
        return xml_valido.encode("utf-8"), "text/xml"

    async def fake_send_fail(*args, **kwargs):
        raise RuntimeError("meta caído")

    monkeypatch.setattr(main_module, "download_media_from_meta", fake_download)
    monkeypatch.setattr(main_module, "send_whatsapp_message", fake_send_fail)

    r = _signed_post(client, "/webhooks/whatsapp", _meta_document_payload("5577777777777"))
    assert r.status_code == 200
    assert r.json()["resultados"][0]["status_code"] == 200


def test_whatsapp_webhook_ignores_non_document_messages(client):
    payload = {
        "object": "whatsapp_business_account",
        "entry": [{"changes": [{"value": {"messages": [
            {"from": "555", "type": "text", "text": {"body": "hola"}},
        ]}}]}],
    }
    r = _signed_post(client, "/webhooks/whatsapp", payload)
    assert r.status_code == 200
    assert r.json()["resultados"] == []


def test_whatsapp_webhook_is_public_no_auth_required(client, xml_valido, monkeypatch):
    """A diferencia de /webhooks/email, este endpoint no requiere Bearer."""
    async def fake_download(media_id, token):
        return xml_valido.encode("utf-8"), "text/xml"

    async def fake_send(*args, **kwargs):
        return {}

    monkeypatch.setattr(main_module, "download_media_from_meta", fake_download)
    monkeypatch.setattr(main_module, "send_whatsapp_message", fake_send)

    r = _signed_post(client, "/webhooks/whatsapp", _meta_document_payload("5566666666666"))
    assert r.status_code == 200  # sin headers de Authorization
