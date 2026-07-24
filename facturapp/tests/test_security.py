"""Tests de rate limiting (Fase 2b) — /auth/login: máx 5/minuto."""
from fastapi.testclient import TestClient

from facturapp.main import app


def test_rate_limit_login_blocks_after_5(client):
    payload = {"email": "ratelimit@example.com", "password": "password123"}
    client.post("/auth/register", json={
        "email": payload["email"], "nombre": "Rate Limit",
        "rfc": "DAXX860715XX0", "password": payload["password"],
    })

    statuses = [client.post("/auth/login", json=payload).status_code for _ in range(6)]

    assert statuses[:5] == [200] * 5
    assert statuses[5] == 429


def test_rate_limit_response_body(client):
    payload = {"email": "rl2@example.com", "password": "password123"}
    client.post("/auth/register", json={
        "email": payload["email"], "nombre": "Rate Limit 2",
        "rfc": "REBB900110AB1", "password": payload["password"],
    })
    for _ in range(5):
        client.post("/auth/login", json=payload)

    r = client.post("/auth/login", json=payload)
    assert r.status_code == 429
    assert r.json()["detail"] == "Demasiados intentos. Intenta de nuevo en un minuto."


def test_rate_limit_counts_failed_attempts_too(client):
    """El límite cuenta TODOS los intentos (también credenciales inválidas)."""
    payload = {"email": "nadie@example.com", "password": "loquesea"}
    statuses = [client.post("/auth/login", json=payload).status_code for _ in range(6)]
    assert statuses[:5] == [401] * 5  # credenciales inválidas, pero cuentan
    assert statuses[5] == 429


def test_rate_limit_is_per_ip(client):
    """El límite es por IP: otra IP no se ve afectada por los intentos de la primera."""
    payload = {"email": "peraddr@example.com", "password": "password123"}
    client.post("/auth/register", json={
        "email": payload["email"], "nombre": "Per IP",
        "rfc": "DAXX860715XX0", "password": payload["password"],
    })

    with TestClient(app, client=("1.2.3.4", 111)) as client_ip_a:
        for _ in range(5):
            client_ip_a.post("/auth/login", json=payload)
        blocked = client_ip_a.post("/auth/login", json=payload)
        assert blocked.status_code == 429

    with TestClient(app, client=("5.6.7.8", 222)) as client_ip_b:
        ok = client_ip_b.post("/auth/login", json=payload)
        assert ok.status_code == 200  # IP distinta, no bloqueada
