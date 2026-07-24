"""Clasificador determinístico de facturas → categoría de deducción.

Fase 1: lookup en tabla en memoria por (uso_cfdi, prefijo de ClaveProdServ).
Si no hay coincidencia devuelve ('Sin clasificar', 'ninguno', 0.0).
"""
from __future__ import annotations

# Categorías deducibles y el prefijo de ClaveProdServ que las identifica.
SIN_CLASIFICAR = "Sin clasificar"


class Classifier:
    def __init__(self) -> None:
        self.rules = [
            {"uso_cfdi": "D02", "clave_prod_prefix": "62", "categoria": "Médicos"},
            {"uso_cfdi": "D02", "clave_prod_prefix": "85", "categoria": "Médicos"},
            {"uso_cfdi": "D01", "clave_prod_prefix": "62", "categoria": "Médicos"},
            {"uso_cfdi": "D02", "clave_prod_prefix": "84", "categoria": "Colegiaturas"},
            {"uso_cfdi": "D10", "clave_prod_prefix": "84", "categoria": "Colegiaturas"},
            {"uso_cfdi": "D02", "clave_prod_prefix": "51", "categoria": "Seguros GMM"},
            {"uso_cfdi": "D07", "clave_prod_prefix": "84", "categoria": "Seguros GMM"},
            {"uso_cfdi": "D02", "clave_prod_prefix": "23", "categoria": "Hipoteca"},
            {"uso_cfdi": "D05", "clave_prod_prefix": "23", "categoria": "Hipoteca"},
        ]

    def classify(self, invoice: dict) -> tuple[str, str, float]:
        """Devuelve (categoria, origen, confianza)."""
        uso = invoice.get("uso_cfdi", "")
        clave = invoice.get("clave_prod_principal", "") or ""
        for rule in self.rules:
            if uso == rule["uso_cfdi"] and clave.startswith(rule["clave_prod_prefix"]):
                return rule["categoria"], "regla", 0.95
        return SIN_CLASIFICAR, "ninguno", 0.0
