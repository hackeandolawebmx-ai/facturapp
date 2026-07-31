/**
 * Tests del motor de validación (Fase M3) — port 1:1 de
 * facturapp/facturapp/tests/test_validator.py.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { parseCfdi } from "./parser.ts";
import {
  estatusDeHallazgos, type Hallazgo, revalidarRfcAjeno, ValidationEngine,
} from "./validator.ts";

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

// ---- revalidarRfcAjeno (Fase M11) -------------------------------------------
//
// Los hallazgos se evalúan al ingerir y no se recalculan. Como las cuentas
// creadas por WhatsApp o correo nacen con un RFC sintético, toda su
// facturación queda marcada RFC_AJENO; al capturar el RFC real, esa
// advertencia se vuelve autocontradictoria en pantalla.

const AJENO: Hallazgo = {
  codigo: "RFC_AJENO",
  severidad: "advertencia",
  mensaje: "Factura emitida a RFC AUCD870504PU0; no será deducible",
};
const EFECTIVO: Hallazgo = {
  codigo: "PAGO_EFECTIVO",
  severidad: "advertencia",
  mensaje: "Pagada en efectivo: SAT no acepta como deducible.",
};
const REVISAR: Hallazgo = {
  codigo: "EMISOR_SIN_ESPECIALIDAD",
  severidad: "por_revisar",
  mensaje: "El emisor no parece tener especialidad médica",
};

Deno.test("revalidarRfcAjeno: el RFC ya coincide → quita la advertencia y queda válida", () => {
  const r = revalidarRfcAjeno([AJENO], "AUCD870504PU0", "AUCD870504PU0");
  assertEquals(r.hallazgos.length, 0);
  assertEquals(r.estatus, "valida");
});

Deno.test("revalidarRfcAjeno: compara sin distinguir mayúsculas", () => {
  const r = revalidarRfcAjeno([AJENO], "aucd870504pu0", "AUCD870504PU0");
  assertEquals(r.hallazgos.length, 0);
});

Deno.test("revalidarRfcAjeno: el RFC sigue sin coincidir → conserva la advertencia", () => {
  const r = revalidarRfcAjeno([AJENO], "XAXX010101000", "AUCD870504PU0");
  assertEquals(r.hallazgos.length, 1);
  assertEquals(r.hallazgos[0].codigo, "RFC_AJENO");
  assertEquals(r.estatus, "advertencia");
});

Deno.test("revalidarRfcAjeno: agrega la advertencia si antes no estaba y ahora aplica", () => {
  // Caso real: el usuario corrige un RFC mal tecleado y sus facturas dejan
  // de estar a su nombre.
  const r = revalidarRfcAjeno([], "XAXX010101000", "AUCD870504PU0");
  assertEquals(r.hallazgos.length, 1);
  assertEquals(r.hallazgos[0].codigo, "RFC_AJENO");
});

Deno.test("revalidarRfcAjeno: NO toca los demás hallazgos", () => {
  // Pago en efectivo y uso de CFDI no dependen del RFC del usuario;
  // recalcularlos aquí sería reinventar el validador con datos incompletos.
  const r = revalidarRfcAjeno([AJENO, EFECTIVO], "AUCD870504PU0", "AUCD870504PU0");
  assertEquals(r.hallazgos.length, 1);
  assertEquals(r.hallazgos[0].codigo, "PAGO_EFECTIVO");
  assertEquals(r.estatus, "advertencia");
});

Deno.test("revalidarRfcAjeno: el estatus refleja la severidad más alta restante", () => {
  // Quitar RFC_AJENO no debe bajar el estatus a válida si queda algo peor.
  const r = revalidarRfcAjeno([AJENO, REVISAR], "AUCD870504PU0", "AUCD870504PU0");
  assertEquals(r.estatus, "por_revisar");
});

Deno.test("revalidarRfcAjeno: no duplica la advertencia si ya existía", () => {
  const r = revalidarRfcAjeno([AJENO], "XAXX010101000", "AUCD870504PU0");
  assertEquals(r.hallazgos.filter((h) => h.codigo === "RFC_AJENO").length, 1);
});

Deno.test("revalidarRfcAjeno: el mensaje nuevo cita el RFC receptor real", () => {
  const r = revalidarRfcAjeno([], "XAXX010101000", "AUCD870504PU0");
  assertEquals(r.hallazgos[0].mensaje.includes("XAXX010101000"), true);
});

Deno.test("estatusDeHallazgos: sin hallazgos es válida", () => {
  assertEquals(estatusDeHallazgos([]), "valida");
});

Deno.test("estatusDeHallazgos: toma la severidad más alta", () => {
  // En esta escala `advertencia` pesa MÁS que `por_revisar`: una advertencia
  // es un problema confirmado, mientras que "por revisar" es una duda que
  // requiere criterio humano. El orden viene de PRIORIDAD en validator.ts.
  assertEquals(estatusDeHallazgos([EFECTIVO, REVISAR]), "advertencia");
});
