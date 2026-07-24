"""Tests del parser CFDI 4.0."""
import pytest

from facturapp.parser import CFDIParseError, parse_cfdi


def test_parse_valido_campos_clave(xml_valido):
    inv = parse_cfdi(xml_valido)
    assert inv["uuid"] == "A4F29C1D-1234-4ABC-9C1D-1234567890AB"
    assert inv["emisor_rfc"] == "RUAA791102H1A"
    assert "Alejandro Ruiz" in inv["emisor_nombre"]
    assert inv["receptor_rfc"] == "DAXX860715XX0"
    assert inv["fecha_emision"] == "2026-07-12"
    assert inv["subtotal"] == 1000.00
    assert inv["iva"] == 160.00
    assert inv["total"] == 1160.00
    assert inv["uso_cfdi"] == "D02"
    assert inv["forma_pago"] == "03"
    assert inv["clave_prod_principal"] == "629298"
    assert inv["concepto_descripcion"]
    assert inv["raw_xml"]


def test_parse_efectivo_forma_pago(xml_efectivo):
    inv = parse_cfdi(xml_efectivo)
    assert inv["forma_pago"] == "01"
    assert inv["total"] == 1160.00


def test_parse_rfc_ajeno(xml_rfc_ajeno):
    inv = parse_cfdi(xml_rfc_ajeno)
    assert inv["receptor_rfc"] == "XAXX010101000"
    assert inv["total"] == 580.00


def test_parse_duplicado_mismo_uuid(xml_valido, xml_duplicado):
    a = parse_cfdi(xml_valido)
    b = parse_cfdi(xml_duplicado)
    assert a["uuid"] == b["uuid"]


def test_xml_mal_formado_lanza_error():
    with pytest.raises(CFDIParseError):
        parse_cfdi("<esto no es xml valido>")


def test_xml_sin_timbre_lanza_error():
    sin_tfd = (
        '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0">'
        '<cfdi:Emisor Rfc="AAA010101AAA" Nombre="X" RegimenFiscal="601"/>'
        '<cfdi:Receptor Rfc="DAXX860715XX0" UsoCFDI="D02"/>'
        '</cfdi:Comprobante>'
    )
    with pytest.raises(CFDIParseError):
        parse_cfdi(sin_tfd)
