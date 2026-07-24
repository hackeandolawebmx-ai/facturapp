"""Tests del clasificador determinístico."""
from facturapp.classifier import Classifier
from facturapp.parser import parse_cfdi


def test_clasifica_medicos(xml_valido):
    inv = parse_cfdi(xml_valido)
    cat, origen, conf = Classifier().classify(inv)
    assert cat == "Médicos"
    assert origen == "regla"
    assert conf == 0.95


def test_clasifica_colegiaturas():
    inv = {"uso_cfdi": "D10", "clave_prod_principal": "841216"}
    cat, origen, conf = Classifier().classify(inv)
    assert cat == "Colegiaturas"


def test_clasifica_seguros():
    inv = {"uso_cfdi": "D02", "clave_prod_principal": "512017"}
    cat, _, _ = Classifier().classify(inv)
    assert cat == "Seguros GMM"


def test_sin_clasificar():
    inv = {"uso_cfdi": "G03", "clave_prod_principal": "010101"}
    cat, origen, conf = Classifier().classify(inv)
    assert cat == "Sin clasificar"
    assert conf == 0.0
