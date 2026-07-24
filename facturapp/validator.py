"""Motor de validación — 7 reglas CFDI para deducciones (Fase 1).

Cada regla es un método que devuelve un hallazgo (dict) o ``None``.
``validate`` agrega los hallazgos y calcula un estatus final por severidad.
"""
from __future__ import annotations

from .classifier import Classifier

# Severidades y su prioridad (mayor = domina el estatus final).
SEV_VALIDA = "valida"
SEV_ADVERTENCIA = "advertencia"
SEV_POR_REVISAR = "por_revisar"
SEV_RECHAZADA = "rechazada"

_PRIORIDAD = {
    SEV_VALIDA: 0,
    SEV_POR_REVISAR: 1,
    SEV_ADVERTENCIA: 2,
    SEV_RECHAZADA: 3,
}

# Categorías donde el SAT exige pago electrónico.
_CATEGORIAS_PAGO_ELECTRONICO = {"Médicos", "Colegiaturas", "Seguros GMM"}
# Usos de CFDI genéricos que no permiten deducir.
_USOS_GENERICOS = {"G03", "S01"}
# Prefijos de ClaveProdServ que "parecen deducibles".
_PREFIJOS_DEDUCIBLES = ("62", "84", "51", "23", "85")
# Palabras que evidencian un emisor del ramo médico.
_KEYWORDS_MEDICO = (
    "medic", "médic", "doctor", "dr.", "dra.", "dental", "dentista",
    "psic", "hospital", "clinic", "clínic", "consultorio", "salud",
)


class ValidationEngine:
    def __init__(self, user_rfc: str, existing_uuids: list[str] | None = None,
                 classifier: Classifier | None = None) -> None:
        self.user_rfc = user_rfc.upper()
        self.existing_uuids = {u.upper() for u in (existing_uuids or [])}
        self.classifier = classifier or Classifier()

    # ---- Reglas individuales -------------------------------------------------

    def _regla_uuid_duplicado(self, inv: dict, ctx: dict):
        if inv.get("uuid", "").upper() in self.existing_uuids:
            fecha = ctx.get("fecha_previa") or inv.get("fecha_emision", "")
            return {
                "codigo": "UUID_DUPLICADO",
                "severidad": SEV_RECHAZADA,
                "mensaje": f"Ya tenías registrada esta factura (recibida el {fecha})",
            }
        return None

    def _regla_rfc_ajeno(self, inv: dict, ctx: dict):
        if inv.get("receptor_rfc", "").upper() != self.user_rfc:
            return {
                "codigo": "RFC_AJENO",
                "severidad": SEV_ADVERTENCIA,
                "mensaje": f"Factura emitida a RFC {inv.get('receptor_rfc')}; no será deducible",
            }
        return None

    def _regla_pago_efectivo(self, inv: dict, ctx: dict):
        if inv.get("forma_pago") == "01" and ctx["categoria"] in _CATEGORIAS_PAGO_ELECTRONICO:
            return {
                "codigo": "PAGO_EFECTIVO",
                "severidad": SEV_ADVERTENCIA,
                "mensaje": ("Pagada en efectivo: SAT no acepta como deducible. "
                            "Pide refacturación con pago electrónico"),
            }
        return None

    def _regla_uso_cfdi_incorrecto(self, inv: dict, ctx: dict):
        clave = inv.get("clave_prod_principal", "") or ""
        parece_deducible = clave.startswith(_PREFIJOS_DEDUCIBLES)
        if inv.get("uso_cfdi") in _USOS_GENERICOS and parece_deducible:
            return {
                "codigo": "USO_CFDI_INCORRECTO",
                "severidad": SEV_ADVERTENCIA,
                "mensaje": "Uso de CFDI incorrecto (esperado D02); pide corrección al emisor",
            }
        return None

    def _regla_emisor_sin_especialidad(self, inv: dict, ctx: dict):
        if ctx["categoria"] == "Médicos":
            nombre = (inv.get("emisor_nombre") or "").lower()
            if not any(k in nombre for k in _KEYWORDS_MEDICO):
                return {
                    "codigo": "EMISOR_SIN_ESPECIALIDAD",
                    "severidad": SEV_POR_REVISAR,
                    "mensaje": ("El SAT exige que el emisor sea profesional colegiado; "
                                "verifica que tenga cédula"),
                }
        return None

    # ---- Orquestación --------------------------------------------------------

    def validate(self, invoice: dict, fecha_previa: str | None = None) -> dict:
        categoria, _, _ = self.classifier.classify(invoice)
        ctx = {"categoria": categoria, "fecha_previa": fecha_previa}

        hallazgos = []
        for regla in (
            self._regla_uuid_duplicado,
            self._regla_rfc_ajeno,
            self._regla_pago_efectivo,
            self._regla_uso_cfdi_incorrecto,
            self._regla_emisor_sin_especialidad,
        ):
            hallazgo = regla(invoice, ctx)
            if hallazgo:
                hallazgos.append(hallazgo)

        status = SEV_VALIDA
        for h in hallazgos:
            if _PRIORIDAD[h["severidad"]] > _PRIORIDAD[status]:
                status = h["severidad"]

        return {"status": status, "categoria": categoria, "hallazgos": hallazgos}
