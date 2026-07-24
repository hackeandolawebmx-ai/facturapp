# FacturasMX Fase 1 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Backend Python + FastAPI que ingiere CFDI 4.0 (XML), lo parsea, lo valida con 7 reglas, lo clasifica en categorías de deducción, lo guarda en BD y expone un resumen anual.

**Architecture:** Módulos puros y testeables (`parser`, `validator`, `classifier`) orquestados por endpoints FastAPI. BD SQLite en-memory (StaticPool, compartida) vía SQLAlchemy. Web servida como HTML que consume `/api/summary` y `/api/invoices`.

**Tech Stack:** Python 3.12+ · FastAPI · lxml · SQLAlchemy · Pytest · httpx (TestClient)

---

## Tareas (bite-sized, TDD)

### Task 1 — Estructura base + app mínima
- Create: `facturasmx/main.py` (`GET /health`), `.env.example`, `requirements.txt`
- Success: `uvicorn facturasmx.main:app` arranca; `GET /health` → `{"status":"ok"}`

### Task 2 — Seeds XML CFDI 4.0
- Create: `seeds/cfdi-valido.xml`, `cfdi-efectivo.xml`, `cfdi-rfc-ajeno.xml`, `cfdi-duplicado.xml`
- Success: los 4 parsean con lxml sin error.

### Task 3 — Parser (`parser.py`)
- `parse_cfdi(xml_string) -> dict`; namespaces CFDI 4.0/TFD; `CFDIParseError` si falta UUID/TFD.
- Test: `tests/test_parser.py` — los 4 seeds extraen UUID, RFCs, montos, uso, forma_pago, clave_prod.

### Task 4 — Classifier (`classifier.py`)
- `Classifier.classify(invoice) -> (categoria, origen, confianza)`; lookup tabla uso_cfdi + prefijo clave.
- Test: `tests/test_classifier.py`.

### Task 5 — Validator (`validator.py`)
- `ValidationEngine(user_rfc).validate(invoice) -> {status, hallazgos}` con las 7 reglas.
- Test: `tests/test_validator.py` — valido/efectivo/rfc-ajeno/duplicado.

### Task 6 — Modelo BD (`models.py`)
- SQLAlchemy `Invoice` en SQLite `:memory:` (StaticPool). `init_db`, `reset_db`, `SessionLocal`.

### Task 7 — Endpoints (`main.py`)
- `POST /webhooks/email`, `GET /api/summary`, `GET /api/invoices`, `GET /a/{token}`.

### Task 8 — Web dinámica
- `templates/dashboard.html` consume APIs y pinta cédula + tabla reales.

### Task 9 — Tests end-to-end (`tests/test_endpoints.py`)
- POST seeds → summary correcto; duplicado rechazado; hallazgos correctos.

### Task 10 — README + verde
- `pytest tests/ -v` todo verde; README con instalación/uso.

## Criterio de éxito global
`pytest facturasmx/tests -v` en verde y flujo POST→summary funcionando en <1s.
