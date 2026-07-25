"""Tests de ingesta de facturas vía email (Fase 3a, webhook SendGrid)."""
import base64

from facturapp.database import SessionLocal
from facturapp.models import Invoice, User


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _webhook_payload(from_email: str, attachments: list[dict], to: str = "daniel@facturapp.mx") -> dict:
    return {"from": from_email, "to": to, "attachments": attachments}


def test_email_webhook_with_xml(client, xml_valido):
    """Se procesa y guarda; el RFC placeholder del usuario auto-creado no
    coincide con el receptor del CFDI, así que se espera advertencia
    RFC_AJENO (comportamiento correcto, no un bug — se resuelve cuando el
    usuario completa su RFC real en el perfil)."""
    payload = _webhook_payload("nueva@example.com", [
        {"filename": "factura.xml", "content": _b64(xml_valido)},
    ])
    r = client.post("/webhooks/sendgrid", json=payload)
    assert r.status_code == 200
    resultado = r.json()["resultados"][0]
    assert resultado["estatus"] == "advertencia"
    assert resultado["hallazgos"][0]["codigo"] == "RFC_AJENO"
    assert resultado["categoria"] == "Médicos"

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "nueva@example.com").first()
        assert user is not None
        inv = db.query(Invoice).filter(Invoice.user_id == user.id).first()
        assert inv is not None  # advertencia SÍ se guarda (solo "rechazada" no)
        assert inv.categoria == "Médicos"
    finally:
        db.close()


def test_email_webhook_with_pdf(client):
    payload = _webhook_payload("pdfuser@example.com", [
        {"filename": "factura.pdf", "content": _b64("%PDF-1.4 contenido falso")},
    ])
    r = client.post("/webhooks/sendgrid", json=payload)
    assert r.status_code == 200
    resultado = r.json()["resultados"][0]
    assert resultado["status_code"] == 202
    assert resultado["estatus"] == "por_revisar"


def test_email_webhook_creates_minimal_user_for_unknown_sender(client, xml_valido):
    payload = _webhook_payload("desconocido@example.com", [
        {"filename": "factura.xml", "content": _b64(xml_valido)},
    ])
    r = client.post("/webhooks/sendgrid", json=payload)
    assert r.status_code == 200

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "desconocido@example.com").first()
        assert user is not None
        assert len(user.rfc) == 13
        assert user.rfc.startswith("PEND")
        assert user.nombre == "desconocido"
    finally:
        db.close()


def test_email_webhook_multiple_attachments(client, xml_valido):
    payload = _webhook_payload("multi@example.com", [
        {"filename": "factura.xml", "content": _b64(xml_valido)},
        {"filename": "factura.pdf", "content": _b64("%PDF-1.4 duplicado")},
    ])
    r = client.post("/webhooks/sendgrid", json=payload)
    assert r.status_code == 200
    filenames = {res["filename"] for res in r.json()["resultados"]}
    assert filenames == {"attachment.xml", "attachment.pdf"}


def test_email_webhook_no_attachments(client):
    payload = _webhook_payload("vacio@example.com", [])
    r = client.post("/webhooks/sendgrid", json=payload)
    assert r.status_code == 202
    assert r.json()["estatus"] == "sin_adjuntos"


def test_email_webhook_ignores_unsupported_attachment(client):
    payload = _webhook_payload("otro@example.com", [
        {"filename": "nota.txt", "content": _b64("solo texto, no es factura")},
    ])
    r = client.post("/webhooks/sendgrid", json=payload)
    assert r.status_code == 202
    assert r.json()["estatus"] == "sin_adjuntos"


def test_email_webhook_extracts_sender_from_display_name(client, xml_valido):
    payload = _webhook_payload('"Daniela Ávila" <daniela.display@example.com>', [
        {"filename": "factura.xml", "content": _b64(xml_valido)},
    ])
    r = client.post("/webhooks/sendgrid", json=payload)
    assert r.status_code == 200

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "daniela.display@example.com").first()
        assert user is not None
    finally:
        db.close()


def test_email_webhook_reuses_existing_user(client, xml_valido, xml_efectivo):
    """Dos correos del mismo remitente usan la MISMA cuenta (no duplica usuarios)."""
    payload1 = _webhook_payload("recurrente@example.com", [
        {"filename": "factura1.xml", "content": _b64(xml_valido)},
    ])
    client.post("/webhooks/sendgrid", json=payload1)

    payload2 = _webhook_payload("recurrente@example.com", [
        {"filename": "factura2.xml", "content": _b64(xml_efectivo)},
    ])
    client.post("/webhooks/sendgrid", json=payload2)

    db = SessionLocal()
    try:
        users = db.query(User).filter(User.email == "recurrente@example.com").all()
        assert len(users) == 1
        invoices = db.query(Invoice).filter(Invoice.user_id == users[0].id).all()
        assert len(invoices) == 2
    finally:
        db.close()


def test_email_webhook_requires_no_auth(client, xml_valido):
    """A diferencia de /webhooks/email, este endpoint es público (sin Bearer)."""
    payload = _webhook_payload("sinauth@example.com", [
        {"filename": "factura.xml", "content": _b64(xml_valido)},
    ])
    r = client.post("/webhooks/sendgrid", json=payload)  # sin headers de auth
    assert r.status_code == 200


def test_manual_upload_endpoint_still_requires_auth(client, xml_valido):
    """El endpoint autenticado original NO cambió de comportamiento."""
    r = client.post(
        "/webhooks/email",
        files={"file": ("v.xml", xml_valido.encode("utf-8"), "application/xml")},
    )
    assert r.status_code == 401
