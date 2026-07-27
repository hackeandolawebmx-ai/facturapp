/**
 * Tests del motor de validación (Fase M3) — port 1:1 de
 * facturapp/facturapp/tests/test_validator.py.
 */
import { assertEquals } from "@std/assert";
import { parseCfdi } from "./parser.ts";
import { type Hallazgo, ValidationEngine } from "./validator.ts";

const USER_RFC = "DAXX860715XX0";

const testdata = (name: string) =>
  Deno.readTextFileSync(new URL(`./testdata/${name}`, import.meta.url));

function codigos(resultado: { hallazgos: Hallazgo[] }): string[] {
  return resultado.hallazgos.map((h) => h.codigo);
}

Deno.test("CFDI válido: sin hallazgos (test_valido_sin_hallazgos)", () => {
  const inv = parseCfdi(testdata("valido.xml"));
  const res = new ValidationEngine(USER_RFC).validate(inv);
  assertEquals(res.status, "valida");
  assertEquals(res.hallazgos, []);
});

Deno.test("pago efectivo: advertencia (test_efectivo_advierte_pago_efectivo)", () => {
  const inv = parseCfdi(testdata("efectivo.xml"));
  const res = new ValidationEngine(USER_RFC).validate(inv);
  assertEquals(res.status, "advertencia");
  assertEquals(codigos(res), ["PAGO_EFECTIVO"]);
});

Deno.test("RFC ajeno: advertencia (test_rfc_ajeno_advierte)", () => {
  const inv = parseCfdi(testdata("rfc-ajeno.xml"));
  const res = new ValidationEngine(USER_RFC).validate(inv);
  assertEquals(res.status, "advertencia");
  assertEquals(codigos(res), ["RFC_AJENO"]);
});

Deno.test("UUID duplicado: rechazada (test_duplicado_rechazado)", () => {
  const invValido = parseCfdi(testdata("valido.xml"));
  const invDup = parseCfdi(testdata("duplicado.xml"));
  const engine = new ValidationEngine(USER_RFC, [invValido.uuid]);
  const res = engine.validate(invDup);
  assertEquals(res.status, "rechazada");
  assertEquals(codigos(res), ["UUID_DUPLICADO"]);
});

Deno.test("uso de CFDI incorrecto (test_uso_cfdi_incorrecto)", () => {
  const inv = {
    uuid: "X", receptor_rfc: USER_RFC, emisor_nombre: "Dr. House",
    forma_pago: "03", uso_cfdi: "G03", clave_prod_principal: "629298",
  };
  const res = new ValidationEngine(USER_RFC).validate(inv);
  assertEquals(codigos(res).includes("USO_CFDI_INCORRECTO"), true);
});

Deno.test("emisor sin especialidad médica (test_emisor_sin_especialidad)", () => {
  const inv = {
    uuid: "Y", receptor_rfc: USER_RFC, emisor_nombre: "Ferretería La Nacional",
    forma_pago: "03", uso_cfdi: "D02", clave_prod_principal: "629298",
  };
  const res = new ValidationEngine(USER_RFC).validate(inv);
  assertEquals(res.status, "por_revisar");
  assertEquals(codigos(res).includes("EMISOR_SIN_ESPECIALIDAD"), true);
});
