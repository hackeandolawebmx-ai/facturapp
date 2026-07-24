"""Tests del chat conversacional (Fase 2a).

El LLM se mockea (no gasta API, corre offline). Se verifica:
- Clasificación de intención (determinística).
- Function calling: el orquestador ejecuta la herramienta y devuelve datos reales.
- Aislamiento de datos entre usuarios.
"""
from types import SimpleNamespace

import httpx
import openai
import pytest

from facturapp import chat as chat_module
from facturapp.chat import (
    ChatIntent, ChatServiceError, classify_intent, tool_get_summary, tool_list_invoices,
)
from facturapp.database import SessionLocal
from facturapp.models import Invoice, User

from .conftest import register_and_login


# ---- Intención (sin LLM) --------------------------------------------------

def test_intent_classification():
    assert classify_intent("¿Cuánto llevo en médicos?") == ChatIntent.RESUMEN
    assert classify_intent("Muéstrame mis facturas de marzo") == ChatIntent.LISTAR
    assert classify_intent("Exporta todo a ZIP") == ChatIntent.EXPORTAR
    assert classify_intent("La última reclasifícala a seguros") == ChatIntent.RECLASIFICAR
    assert classify_intent("¿Qué puedo deducir?") == ChatIntent.AYUDA


# ---- Helpers de mock ------------------------------------------------------

def _tool_call(name, arguments="{}"):
    return SimpleNamespace(id="call_1", function=SimpleNamespace(name=name, arguments=arguments))


def _fake_completion_for(tool_name):
    """Primera llamada → pide la herramienta; segunda → responde con su resultado."""
    def fake(messages, tools):
        if not any(m.get("role") == "tool" for m in messages):
            return SimpleNamespace(content=None, tool_calls=[_tool_call(tool_name)])
        tool_msg = [m for m in messages if m["role"] == "tool"][-1]
        return SimpleNamespace(content="Aquí tienes: " + tool_msg["content"], tool_calls=None)
    return fake


def _seed_invoice(user_id, uuid, total=1160.0, categoria="Médicos"):
    db = SessionLocal()
    try:
        db.add(Invoice(
            user_id=user_id, uuid_fiscal=uuid, usuario_rfc="DAXX860715XX0",
            emisor_nombre="Consultorio Dr. X", receptor_rfc="DAXX860715XX0",
            fecha_emision="2026-07-12", anio=2026, total=total,
            categoria=categoria, estatus="valida", hallazgos=[],
        ))
        db.commit()
    finally:
        db.close()


def _user_id(email):
    db = SessionLocal()
    try:
        return db.query(User).filter(User.email == email).first().id
    finally:
        db.close()


# ---- Chat con function calling -------------------------------------------

def test_chat_get_summary(client, monkeypatch):
    headers = register_and_login(client, "a@example.com", "DAXX860715XX0")
    _seed_invoice(_user_id("a@example.com"), "UUID-A-1", total=1160.0)

    monkeypatch.setattr(chat_module, "_chat_completion", _fake_completion_for("get_summary"))
    r = client.post("/api/chat", json={"message": "¿cuánto llevo?"}, headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert "get_summary" in body["tools_used"]
    assert "1160" in body["response"]  # el monto real llega vía la herramienta


def test_chat_list_invoices(client, monkeypatch):
    headers = register_and_login(client, "b@example.com", "DAXX860715XX0")
    _seed_invoice(_user_id("b@example.com"), "UUID-B-1")

    monkeypatch.setattr(chat_module, "_chat_completion", _fake_completion_for("list_invoices"))
    r = client.post("/api/chat", json={"message": "mis facturas de julio"}, headers=headers)
    assert r.status_code == 200
    assert "list_invoices" in r.json()["tools_used"]
    assert "UUID-B-1" in r.json()["response"]


def test_chat_requires_auth(client):
    r = client.post("/api/chat", json={"message": "hola"})
    assert r.status_code == 401


def test_data_isolation(client):
    """Cada usuario solo ve sus propias facturas vía las herramientas."""
    register_and_login(client, "ana@example.com", "DAXX860715XX0")
    register_and_login(client, "beto@example.com", "REBB900110AB1")
    id_ana, id_beto = _user_id("ana@example.com"), _user_id("beto@example.com")
    _seed_invoice(id_ana, "UUID-ANA", total=1000.0)
    _seed_invoice(id_beto, "UUID-BETO", total=9999.0)

    db = SessionLocal()
    try:
        ana = db.get(User, id_ana)
        beto = db.get(User, id_beto)
        res_ana = tool_list_invoices(db, ana, year=2026)
        res_beto = tool_get_summary(db, beto, year=2026)

        uuids_ana = [i["uuid"] for i in res_ana["invoices"]]
        assert uuids_ana == ["UUID-ANA"]
        assert "UUID-BETO" not in uuids_ana
        assert res_beto["total_general"] == 9999.0
    finally:
        db.close()


# ---- Manejo de errores de OpenAI (Fase 2b) --------------------------------

def _fake_client_raising(exc: Exception):
    """Cliente OpenAI falso cuyo .chat.completions.create lanza `exc`."""
    class FakeCompletions:
        def create(self, **kwargs):
            raise exc

    class FakeChat:
        completions = FakeCompletions()

    class FakeClient:
        chat = FakeChat()

    return FakeClient()


def test_chat_completion_translates_rate_limit_error(monkeypatch):
    exc = openai.RateLimitError(
        "rate limited",
        response=httpx.Response(429, request=httpx.Request("POST", "http://test")),
        body=None,
    )
    monkeypatch.setattr(chat_module, "_get_client", lambda: _fake_client_raising(exc))

    with pytest.raises(ChatServiceError) as exc_info:
        chat_module._chat_completion([{"role": "user", "content": "hola"}], chat_module.TOOLS)
    assert "ocupado" in exc_info.value.user_message.lower()


def test_chat_completion_translates_api_error(monkeypatch):
    exc = openai.APIError("boom", request=httpx.Request("POST", "http://test"), body=None)
    monkeypatch.setattr(chat_module, "_get_client", lambda: _fake_client_raising(exc))

    with pytest.raises(ChatServiceError) as exc_info:
        chat_module._chat_completion([{"role": "user", "content": "hola"}], chat_module.TOOLS)
    assert "conectarme" in exc_info.value.user_message.lower()


def test_chat_completion_translates_generic_openai_error(monkeypatch):
    monkeypatch.setattr(
        chat_module, "_get_client", lambda: _fake_client_raising(openai.OpenAIError("weird"))
    )

    with pytest.raises(ChatServiceError):
        chat_module._chat_completion([{"role": "user", "content": "hola"}], chat_module.TOOLS)


def test_chat_orchestrator_returns_friendly_message_on_openai_failure(client, monkeypatch):
    """chat() no propaga el error: responde 200 con un mensaje legible."""
    headers = register_and_login(client, "fail@example.com", "DAXX860715XX0")

    def boom(messages, tools):
        raise ChatServiceError("Tengo problemas para conectarme con el asistente. Intenta más tarde.")

    monkeypatch.setattr(chat_module, "_chat_completion", boom)
    r = client.post("/api/chat", json={"message": "hola"}, headers=headers)
    assert r.status_code == 200
    assert "problemas" in r.json()["response"].lower()
    assert r.json()["tools_used"] == []


def test_chat_endpoint_500_on_unexpected_error(client, monkeypatch):
    """Un error NO relacionado con OpenAI (bug, DB, etc.) da 500 sin traceback."""
    headers = register_and_login(client, "bug@example.com", "DAXX860715XX0")

    def raises_unexpected(db, user, message):
        raise RuntimeError("boom inesperado")

    monkeypatch.setattr(chat_module, "chat", raises_unexpected)
    r = client.post("/api/chat", json={"message": "hola"}, headers=headers)
    assert r.status_code == 500
    assert "boom inesperado" not in r.text  # no traceback expuesto
    assert r.json()["detail"] == "Error procesando tu mensaje."
