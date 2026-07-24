"""Tests del motor de validación (7 reglas)."""
from facturapp.parser import parse_cfdi
from facturapp.validator import ValidationEngine

USER_RFC = "DAXX860715XX0"


def _codigos(resultado):
    return [h["codigo"] for h in resultado["hallazgos"]]


def test_valido_sin_hallazgos(xml_valido):
    inv = parse_cfdi(xml_valido)
    res = ValidationEngine(USER_RFC).validate(inv)
    assert res["status"] == "valida"
    assert res["hallazgos"] == []


def test_efectivo_advierte_pago_efectivo(xml_efectivo):
    inv = parse_cfdi(xml_efectivo)
    res = ValidationEngine(USER_RFC).validate(inv)
    assert res["status"] == "advertencia"
    assert _codigos(res) == ["PAGO_EFECTIVO"]


def test_rfc_ajeno_advierte(xml_rfc_ajeno):
    inv = parse_cfdi(xml_rfc_ajeno)
    res = ValidationEngine(USER_RFC).validate(inv)
    assert res["status"] == "advertencia"
    assert _codigos(res) == ["RFC_AJENO"]


def test_duplicado_rechazado(xml_valido, xml_duplicado):
    inv_valido = parse_cfdi(xml_valido)
    inv_dup = parse_cfdi(xml_duplicado)
    engine = ValidationEngine(USER_RFC, existing_uuids=[inv_valido["uuid"]])
    res = engine.validate(inv_dup)
    assert res["status"] == "rechazada"
    assert _codigos(res) == ["UUID_DUPLICADO"]


def test_uso_cfdi_incorrecto():
    inv = {
        "uuid": "X", "receptor_rfc": USER_RFC, "emisor_nombre": "Dr. House",
        "forma_pago": "03", "uso_cfdi": "G03", "clave_prod_principal": "629298",
    }
    res = ValidationEngine(USER_RFC).validate(inv)
    assert "USO_CFDI_INCORRECTO" in _codigos(res)


def test_emisor_sin_especialidad():
    inv = {
        "uuid": "Y", "receptor_rfc": USER_RFC, "emisor_nombre": "Ferretería La Nacional",
        "forma_pago": "03", "uso_cfdi": "D02", "clave_prod_principal": "629298",
    }
    res = ValidationEngine(USER_RFC).validate(inv)
    assert res["status"] == "por_revisar"
    assert "EMISOR_SIN_ESPECIALIDAD" in _codigos(res)
