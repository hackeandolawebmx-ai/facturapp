/**
 * Tests del parser CFDI 4.0 (Fase M2) — port 1:1 de
 * facturapp/facturapp/tests/test_parser.py (Fase 1, Python).
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { CFDIParseError, parseCfdi } from "./parser.ts";

const testdata = (name: string) =>
  Deno.readTextFileSync(new URL(`./testdata/${name}`, import.meta.url));

Deno.test("parsea CFDI válido correctamente (test_parse_valido_campos_clave)", () => {
  const inv = parseCfdi(testdata("valido.xml"));
  assertEquals(inv.uuid, "A4F29C1D-1234-4ABC-9C1D-1234567890AB");
  assertEquals(inv.emisor_rfc, "RUAA791102H1A");
  assert(inv.emisor_nombre.includes("Alejandro Ruiz"));
  assertEquals(inv.receptor_rfc, "DAXX860715XX0");
  assertEquals(inv.fecha_emision, "2026-07-12");
  assertEquals(inv.subtotal, 1000.0);
  assertEquals(inv.iva, 160.0);
  assertEquals(inv.total, 1160.0);
  assertEquals(inv.uso_cfdi, "D02");
  assertEquals(inv.forma_pago, "03");
  assertEquals(inv.clave_prod_principal, "629298");
  assert(inv.concepto_descripcion.length > 0);
  assert(inv.raw_xml.length > 0);
});

Deno.test("forma de pago efectivo (test_parse_efectivo_forma_pago)", () => {
  const inv = parseCfdi(testdata("efectivo.xml"));
  assertEquals(inv.forma_pago, "01");
  assertEquals(inv.total, 1160.0);
});

Deno.test("RFC ajeno / público en general (test_parse_rfc_ajeno)", () => {
  const inv = parseCfdi(testdata("rfc-ajeno.xml"));
  assertEquals(inv.receptor_rfc, "XAXX010101000");
  assertEquals(inv.total, 580.0);
});

Deno.test("mismo UUID en original y duplicado (test_parse_duplicado_mismo_uuid)", () => {
  const a = parseCfdi(testdata("valido.xml"));
  const b = parseCfdi(testdata("duplicado.xml"));
  assertEquals(a.uuid, b.uuid);
});

Deno.test("rechaza XML mal formado (test_xml_mal_formado_lanza_error)", () => {
  assertThrows(() => parseCfdi("<esto no es xml valido>"), CFDIParseError);
});

Deno.test("rechaza XML sin timbre fiscal / UUID (test_xml_sin_timbre_lanza_error)", () => {
  const sinTfd =
    '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0">' +
    '<cfdi:Emisor Rfc="AAA010101AAA" Nombre="X" RegimenFiscal="601"/>' +
    '<cfdi:Receptor Rfc="DAXX860715XX0" UsoCFDI="D02"/>' +
    "</cfdi:Comprobante>";
  assertThrows(() => parseCfdi(sinTfd), CFDIParseError);
});

// ---- Casos adicionales específicos de la implementación TS ----------------

Deno.test("acepta Uint8Array además de string (equivalente a bytes en Python)", () => {
  const bytes = new TextEncoder().encode(testdata("valido.xml"));
  const inv = parseCfdi(bytes);
  assertEquals(inv.uuid, "A4F29C1D-1234-4ABC-9C1D-1234567890AB");
});

Deno.test("campos opcionales ausentes son string vacío, nunca null/undefined", () => {
  // CFDI válido pero sin Conceptos (clave_prod_principal/concepto_descripcion
  // deben ser "" — igual que en Python, donde concepto es None).
  const sinConceptos =
    '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" ' +
    'xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" ' +
    'SubTotal="0" Total="0">' +
    '<cfdi:Emisor Rfc="AAA010101AAA" Nombre="X"/>' +
    '<cfdi:Receptor Rfc="DAXX860715XX0"/>' +
    '<cfdi:Complemento>' +
    '<tfd:TimbreFiscalDigital UUID="11111111-1111-1111-1111-111111111111"/>' +
    "</cfdi:Complemento>" +
    "</cfdi:Comprobante>";
  const inv = parseCfdi(sinConceptos);
  assertEquals(inv.clave_prod_principal, "");
  assertEquals(inv.concepto_descripcion, "");
  assertEquals(inv.uso_cfdi, "");
  assertEquals(typeof inv.clave_prod_principal, "string");
});
