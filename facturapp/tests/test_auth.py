"""Tests de registro y login (Fase 2a/2b)."""
import datetime as dt

from jose import jwt

from facturapp.auth import create_access_token, create_refresh_token
from facturapp.config import settings

from .conftest import register_and_login

VALID = {
    "email": "nuevo@example.com", "nombre": "Nuevo Usuario",
    "rfc": "DAXX860715XX0", "password": "password123",
}


def test_register_user(client):
    r = client.post("/auth/register", json=VALID)
    assert r.status_code == 201
    assert r.json()["user_id"] > 0


def test_register_rfc_invalido(client):
    bad = {**VALID, "email": "x@example.com", "rfc": "NO-ES-RFC"}
    r = client.post("/auth/register", json=bad)
    assert r.status_code == 422  # falla validación Pydantic


def test_register_password_corta(client):
    bad = {**VALID, "email": "y@example.com", "password": "corta"}
    r = client.post("/auth/register", json=bad)
    assert r.status_code == 422


def test_login_success(client):
    client.post("/auth/register", json=VALID)
    r = client.post("/auth/login", json={"email": VALID["email"], "password": VALID["password"]})
    assert r.status_code == 200
    body = r.json()
    assert body["token_type"] == "bearer"
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["expires_in"] == settings.access_token_expire_minutes * 60
    assert body["user_id"] > 0


def test_login_fail(client):
    client.post("/auth/register", json=VALID)
    r = client.post("/auth/login", json={"email": VALID["email"], "password": "incorrecta"})
    assert r.status_code == 401


def test_duplicate_rfc(client):
    client.post("/auth/register", json=VALID)
    dup = {**VALID, "email": "otro@example.com"}  # mismo RFC
    r = client.post("/auth/register", json=dup)
    assert r.status_code == 400


def test_profile_requires_auth(client):
    r = client.get("/api/user/profile")
    assert r.status_code == 401


def test_profile_returns_user(client):
    headers = register_and_login(client, "prof@example.com", "DAXX860715XX0")
    r = client.get("/api/user/profile", headers=headers)
    assert r.status_code == 200
    assert r.json()["email"] == "prof@example.com"
    assert r.json()["rfc"] == "DAXX860715XX0"


# ---- RFC: validación estricta de 13 caracteres ---------------------------

def test_register_rfc_12_caracteres_rechazado(client):
    """RFC moral (12 chars) rechazado: solo se acepta persona física (13)."""
    bad = {**VALID, "email": "rfc12@example.com", "rfc": "AAA010101AAA"}
    r = client.post("/auth/register", json=bad)
    assert r.status_code == 422


def test_register_rfc_14_caracteres_rechazado(client):
    bad = {**VALID, "email": "rfc14@example.com", "rfc": "DAXX860715XX00"}
    r = client.post("/auth/register", json=bad)
    assert r.status_code == 422


def test_register_rfc_caracteres_invalidos(client):
    bad = {**VALID, "email": "rfcbad@example.com", "rfc": "DA-X860715XX0"}
    r = client.post("/auth/register", json=bad)
    assert r.status_code == 422


def test_register_rfc_valido_13_chars(client):
    ok = {**VALID, "email": "rfcok@example.com", "rfc": "DAXX860715XX0"}
    r = client.post("/auth/register", json=ok)
    assert r.status_code == 201


def test_rfc_minusculas_se_normaliza(client):
    ok = {**VALID, "email": "rfclower@example.com", "rfc": "daxx860715xx0"}
    r = client.post("/auth/register", json=ok)
    assert r.status_code == 201
    headers = register_and_login(client, "rfclower@example.com", "daxx860715xx0")
    profile = client.get("/api/user/profile", headers=headers).json()
    assert profile["rfc"] == "DAXX860715XX0"


# ---- Refresh tokens (Fase 2b) ---------------------------------------------

def test_refresh_token_returns_new_access_token(client):
    client.post("/auth/register", json=VALID)
    login = client.post("/auth/login", json={
        "email": VALID["email"], "password": VALID["password"],
    }).json()

    r = client.post("/auth/refresh", headers={
        "Authorization": f"Bearer {login['refresh_token']}",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["user_id"] == login["user_id"]

    # El nuevo access_token funciona de verdad contra un endpoint protegido.
    profile = client.get(
        "/api/user/profile", headers={"Authorization": f"Bearer {body['access_token']}"},
    )
    assert profile.status_code == 200


def test_refresh_with_access_token_rejected(client):
    """Un access_token NO sirve como refresh_token (tipos distintos)."""
    client.post("/auth/register", json=VALID)
    login = client.post("/auth/login", json={
        "email": VALID["email"], "password": VALID["password"],
    }).json()

    r = client.post("/auth/refresh", headers={
        "Authorization": f"Bearer {login['access_token']}",
    })
    assert r.status_code == 401


def test_refresh_without_token(client):
    r = client.post("/auth/refresh")
    assert r.status_code == 401


def test_refresh_token_expired(client):
    client.post("/auth/register", json=VALID)
    user_id = client.post("/auth/login", json={
        "email": VALID["email"], "password": VALID["password"],
    }).json()["user_id"]

    expired = create_refresh_token(
        {"sub": str(user_id), "rfc": VALID["rfc"]},
        expires_delta=dt.timedelta(days=-1),
    )
    r = client.post("/auth/refresh", headers={"Authorization": f"Bearer {expired}"})
    assert r.status_code == 401


def test_access_token_expired_rejected(client):
    headers_valid = register_and_login(client, "expira@example.com", "DAXX860715XX0")
    # sigue funcionando con un token no expirado
    assert client.get("/api/user/profile", headers=headers_valid).status_code == 200

    # token creado ya expirado
    from facturapp.models import User
    from facturapp.database import SessionLocal
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == "expira@example.com").first()
        expired_token = create_access_token(
            {"sub": str(user.id), "rfc": user.rfc},
            expires_delta=dt.timedelta(minutes=-1),
        )
    finally:
        db.close()

    r = client.get("/api/user/profile", headers={"Authorization": f"Bearer {expired_token}"})
    assert r.status_code == 401


def test_access_token_type_claim_present():
    token = create_access_token({"sub": "1", "rfc": "DAXX860715XX0"})
    payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    assert payload["type"] == "access"


def test_refresh_token_type_claim_present():
    token = create_refresh_token({"sub": "1", "rfc": "DAXX860715XX0"})
    payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    assert payload["type"] == "refresh"
