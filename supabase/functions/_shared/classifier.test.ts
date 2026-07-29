/**
 * Tests del clasificador (Fase M3) — port 1:1 de
 * facturapp/facturapp/tests/test_classifier.py.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { classifyInvoice } from "./classifier.ts";
import { parseCfdi } from "./parser.ts";

const testdata = (name: string) =>
  Deno.readTextFileSync(new URL(`./testdata/${name}`, import.meta.url));

Deno.test("clasifica Médicos (test_clasifica_medicos)", () => {
  const inv = parseCfdi(testdata("valido.xml"));
  const { categoria, origen, confianza } = classifyInvoice(inv);
  assertEquals(categoria, "Médicos");
  assertEquals(origen, "regla");
  assertEquals(confianza, 0.95);
});

Deno.test("clasifica Colegiaturas (test_clasifica_colegiaturas)", () => {
  const { categoria } = classifyInvoice({ uso_cfdi: "D10", clave_prod_principal: "841216" });
  assertEquals(categoria, "Colegiaturas");
});

Deno.test("clasifica Seguros GMM (test_clasifica_seguros)", () => {
  const { categoria } = classifyInvoice({ uso_cfdi: "D02", clave_prod_principal: "512017" });
  assertEquals(categoria, "Seguros GMM");
});

Deno.test("sin clasificar (test_sin_clasificar)", () => {
  const { categoria, confianza } = classifyInvoice({ uso_cfdi: "G03", clave_prod_principal: "010101" });
  assertEquals(categoria, "Sin clasificar");
  assertEquals(confianza, 0.0);
});
