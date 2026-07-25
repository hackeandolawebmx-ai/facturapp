"""Fixtures compartidas (Fase 2a).

Fija la BD en-memory y credenciales dummy ANTES de importar el paquete,
para que los tests corran offline y deterministas.
"""
from __future__ import annotations

import os

# --- Debe ejecutarse antes de cualquier import de facturapp ---
os.environ.setdefault("DATABASE_URL", "sqlite://")  # SQLite en-memory (StaticPool)
os.environ.setdefault("OPENAI_API_KEY", "sk-test-dummy")
os.environ.setdefault("SECRET_KEY", "test-secret-key-suficientemente-larga-1234567890")
os.environ.setdefault("WHATSAPP_TOKEN", "test-whatsapp-token-dummy")
os.environ.setdefault("WHATSAPP_VERIFY_TOKEN", "test-verify-token-dummy")
os.environ.setdefault("WHATSAPP_APP_SECRET", "test-app-secret-dummy")
os.environ.setdefault("WHATSAPP_PHONE_NUMBER_ID", "1234567890")

from pathlib import Path  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

SEEDS_DIR = Path(__file__).resolve().parent.parent / "seeds"


def _load(name: str) -> str:
    return (SEEDS_DIR / name).read_text(encoding="utf-8")


# ---- Seeds CFDI (sin cambios de Fase 1) ----------------------------------

@pytest.fixture
def xml_valido() -> str:
    return _load("cfdi-valido.xml")


@pytest.fixture
def xml_efectivo() -> str:
    return _load("cfdi-efectivo.xml")


@pytest.fixture
def xml_rfc_ajeno() -> str:
    return _load("cfdi-rfc-ajeno.xml")


@pytest.fixture
def xml_duplicado() -> str:
    return _load("cfdi-duplicado.xml")


# ---- App / BD -------------------------------------------------------------

@pytest.fixture
def client():
    from facturapp.database import reset_db
    from facturapp.main import app
    from facturapp.security import limiter

    reset_db()
    # El limiter es un singleton a nivel de módulo (comparte estado entre
    # tests dentro del mismo proceso). Se resetea por test para que el
    # rate limiting de un test no contamine a los demás (todos comparten
    # la misma "IP" — TestClient usa "testclient" como host fijo).
    limiter.reset()
    with TestClient(app) as c:
        yield c


def register_and_login(client, email: str, rfc: str,
                       password: str = "password123", nombre: str = "Test User") -> dict:
    """Registra e inicia sesión; devuelve headers con el Bearer token."""
    client.post("/auth/register", json={
        "email": email, "nombre": nombre, "rfc": rfc, "password": password,
    })
    r = client.post("/auth/login", json={"email": email, "password": password})
    token = r.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def auth_headers(client) -> dict:
    """Usuario A autenticado (RFC de Daniela)."""
    return register_and_login(client, "daniela@example.com", "DAXX860715XX0")
