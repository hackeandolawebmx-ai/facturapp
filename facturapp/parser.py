"""Parser de CFDI 4.0 → dict.

Usa lxml y maneja los namespaces oficiales del SAT. Extrae los campos
mínimos que necesitan el validador y el clasificador de Fase 1.
"""
from __future__ import annotations

from lxml import etree

NAMESPACES = {
    "cfdi": "http://www.sat.gob.mx/cfd/4",
    "tfd": "http://www.sat.gob.mx/TimbreFiscalDigital",
    "xsi": "http://www.w3.org/2001/XMLSchema-instance",
}


class CFDIParseError(ValueError):
    """El XML no es un CFDI 4.0 válido (mal formado, sin UUID, etc.)."""


def _to_float(value: str | None) -> float:
    if value is None or value == "":
        return 0.0
    try:
        return float(value)
    except ValueError:
        return 0.0


def parse_cfdi(xml_string: str | bytes) -> dict:
    """Parsea una cadena XML de CFDI 4.0 y devuelve un dict normalizado.

    Lanza ``CFDIParseError`` si el XML está mal formado, no es un
    ``cfdi:Comprobante`` 4.0 o le falta el Timbre Fiscal Digital (UUID).
    """
    if isinstance(xml_string, str):
        raw = xml_string
        data = xml_string.encode("utf-8")
    else:
        raw = xml_string.decode("utf-8", errors="replace")
        data = xml_string

    try:
        root = etree.fromstring(data)
    except etree.XMLSyntaxError as exc:
        raise CFDIParseError(f"XML mal formado: {exc}") from exc

    if not root.tag.endswith("}Comprobante"):
        raise CFDIParseError("El nodo raíz no es cfdi:Comprobante")

    emisor = root.find("cfdi:Emisor", NAMESPACES)
    receptor = root.find("cfdi:Receptor", NAMESPACES)
    concepto = root.find("cfdi:Conceptos/cfdi:Concepto", NAMESPACES)
    tfd = root.find("cfdi:Complemento/tfd:TimbreFiscalDigital", NAMESPACES)

    if tfd is None:
        raise CFDIParseError("Falta el nodo TimbreFiscalDigital (no timbrado)")

    uuid = tfd.get("UUID")
    if not uuid:
        raise CFDIParseError("El TimbreFiscalDigital no contiene UUID")

    if emisor is None or receptor is None:
        raise CFDIParseError("Faltan nodos Emisor o Receptor")

    # IVA = suma de traslados a nivel comprobante
    iva = 0.0
    for traslado in root.findall("cfdi:Impuestos/cfdi:Traslados/cfdi:Traslado", NAMESPACES):
        iva += _to_float(traslado.get("Importe"))

    fecha = root.get("Fecha", "")
    fecha_emision = fecha.split("T")[0] if fecha else ""

    return {
        "uuid": uuid.upper(),
        "emisor_rfc": (emisor.get("Rfc") or "").upper(),
        "emisor_nombre": emisor.get("Nombre") or "",
        "receptor_rfc": (receptor.get("Rfc") or "").upper(),
        "fecha_emision": fecha_emision,
        "subtotal": _to_float(root.get("SubTotal")),
        "iva": round(iva, 2),
        "total": _to_float(root.get("Total")),
        "uso_cfdi": receptor.get("UsoCFDI") or "",
        "forma_pago": root.get("FormaPago") or "",
        "metodo_pago": root.get("MetodoPago") or "",
        "clave_prod_principal": (concepto.get("ClaveProdServ") if concepto is not None else "") or "",
        "concepto_descripcion": (concepto.get("Descripcion") if concepto is not None else "") or "",
        "raw_xml": raw,
    }
