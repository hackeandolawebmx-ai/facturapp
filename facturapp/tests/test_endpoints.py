"""Tests end-to-end de endpoints (Fase 2a, multiusuario)."""
from .conftest import register_and_login


def _post_xml(client, xml, filename, headers):
    return client.post(
        "/webhooks/email",
        files={"file": (filename, xml.encode("utf-8"), "application/xml")},
        headers=headers,
    )


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


# ---- Auth requerida -------------------------------------------------------

def test_invoice_requires_auth(client):
    r = client.get("/api/invoices?year=2026")
    assert r.status_code == 401


def test_summary_requires_auth(client):
    r = client.get("/api/summary?year=2026")
    assert r.status_code == 401


def test_webhook_requires_auth(client, xml_valido):
    r = _post_xml(client, xml_valido, "v.xml", headers={})
    assert r.status_code == 401


# ---- Ingesta (con auth) ---------------------------------------------------

def test_ingesta_valido(client, auth_headers, xml_valido):
    r = _post_xml(client, xml_valido, "valido.xml", auth_headers)
    assert r.status_code == 200
    body = r.json()
    assert body["estatus"] == "valida"
    assert body["categoria"] == "Médicos"
    assert body["hallazgos"] == []


def test_ingesta_duplicado_rechazado(client, auth_headers, xml_valido, xml_duplicado):
    _post_xml(client, xml_valido, "valido.xml", auth_headers)
    r = _post_xml(client, xml_duplicado, "dup.xml", auth_headers)
    assert r.json()["estatus"] == "rechazada"
    assert r.json()["hallazgos"][0]["codigo"] == "UUID_DUPLICADO"


def test_ingesta_efectivo_advertencia(client, auth_headers, xml_efectivo):
    r = _post_xml(client, xml_efectivo, "efectivo.xml", auth_headers)
    assert r.json()["estatus"] == "advertencia"
    assert r.json()["hallazgos"][0]["codigo"] == "PAGO_EFECTIVO"


def test_summary_totales(client, auth_headers, xml_valido, xml_efectivo):
    _post_xml(client, xml_valido, "valido.xml", auth_headers)
    _post_xml(client, xml_efectivo, "efectivo.xml", auth_headers)
    r = client.get("/api/summary?year=2026", headers=auth_headers)
    body = r.json()
    assert body["categorias"]["Médicos"]["total"] == 2320.00
    assert body["categorias"]["Médicos"]["facturas"] == 2


# ---- Aislamiento entre usuarios ------------------------------------------

def test_invoice_filters_by_user(client, auth_headers, xml_valido):
    # Usuario A sube una factura
    _post_xml(client, xml_valido, "valido.xml", auth_headers)

    # Usuario B no ve nada de A
    headers_b = register_and_login(client, "beto@example.com", "REBB900110AB1")
    r = client.get("/api/invoices?year=2026", headers=headers_b)
    assert r.status_code == 200
    assert r.json()["invoices"] == []

    # A sí ve la suya
    ra = client.get("/api/invoices?year=2026", headers=auth_headers)
    assert len(ra.json()["invoices"]) == 1


def test_duplicado_permitido_entre_usuarios(client, auth_headers, xml_valido):
    """El mismo UUID en dos usuarios distintos NO es duplicado (aislamiento)."""
    _post_xml(client, xml_valido, "v.xml", auth_headers)
    headers_b = register_and_login(client, "beto@example.com", "REBB900110AB1")
    r = _post_xml(client, xml_valido, "v.xml", headers_b)
    # Para B es RFC_AJENO (receptor es de A), pero NO rechazada por duplicado.
    assert r.json()["estatus"] != "rechazada"


# ---- Web dashboard --------------------------------------------------------

def test_web_dashboard(client, auth_headers):
    r = client.get("/api/user/profile", headers=auth_headers)
    token = r.json()["web_token"]
    w = client.get(f"/a/{token}")
    assert w.status_code == 200
    assert "Facturas" in w.text


def test_public_summary_by_token(client, auth_headers, xml_valido):
    _post_xml(client, xml_valido, "valido.xml", auth_headers)
    token = client.get("/api/user/profile", headers=auth_headers).json()["web_token"]
    r = client.get(f"/api/public/summary?token={token}&year=2026")
    assert r.status_code == 200
    assert r.json()["categorias"]["Médicos"]["facturas"] == 1
