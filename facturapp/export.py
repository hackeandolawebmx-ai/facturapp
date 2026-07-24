"""Exportación ZIP + Excel — mock de Fase 1 (real en Fase 4)."""
from __future__ import annotations


def export_excel(invoices: list[dict]) -> dict:
    """Mock: en Fase 4 generará un .xlsx real."""
    return {"formato": "xlsx", "filas": len(invoices), "status": "mock_fase4"}


def export_zip(invoices: list[dict]) -> dict:
    """Mock: en Fase 4 empaquetará XML + PDF en un ZIP."""
    return {"formato": "zip", "archivos": len(invoices), "status": "mock_fase4"}
