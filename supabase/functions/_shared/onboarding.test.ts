/**
 * Tests de activación de cuenta (Fase M24).
 *
 * El grueso está en `mensajeEsRfc`, que es donde una equivocación tiene
 * consecuencia real: si captura de más, le asigna a la cuenta de alguien el
 * RFC de un tercero mencionado de pasada -- y con él, la atribución de todas
 * sus facturas.
 */
import { assertEquals } from "jsr:@std/assert@1";
import {
  capturarRfc, confirmacionRfc, errorCaptura, mensajeEsRfc, tieneRfcPendiente,
} from "./onboarding.ts";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";

const RFC_VALIDO = "DAXX860715XX0";

// ---- tieneRfcPendiente -------------------------------------------------------

Deno.test("tieneRfcPendiente: reconoce el RFC sintético de alta automática", () => {
  assertEquals(tieneRfcPendiente("PEND41EAF8FF9"), true);
  assertEquals(tieneRfcPendiente(RFC_VALIDO), false);
  assertEquals(tieneRfcPendiente(null), false);
  assertEquals(tieneRfcPendiente(undefined), false);
  assertEquals(tieneRfcPendiente(""), false);
});

// ---- mensajeEsRfc ------------------------------------------------------------

Deno.test("mensajeEsRfc: acepta un RFC solo, con espacios alrededor o en minúsculas", () => {
  assertEquals(mensajeEsRfc(RFC_VALIDO), true);
  assertEquals(mensajeEsRfc("  " + RFC_VALIDO + "  "), true);
  assertEquals(mensajeEsRfc("daxx860715xx0"), true);
});

Deno.test("mensajeEsRfc: acepta el largo de persona moral (12) para poder explicarlo", () => {
  // No se captura como RFC de la cuenta -- capturarRfc lo rechaza con un
  // mensaje que dice a dónde va el de la empresa. Pero tiene que llegar hasta
  // ahí, y para eso el detector debe reconocerlo.
  assertEquals(mensajeEsRfc("DJB850527F30"), true);
});

Deno.test("mensajeEsRfc: NO captura un RFC mencionado dentro de una frase", () => {
  // El caso que importa: alguien preguntando por la factura de un TERCERO no
  // está declarando su propio RFC. Capturarlo le cambiaría la identidad
  // fiscal a la cuenta y reatribuiría sus facturas.
  assertEquals(mensajeEsRfc(`por qué la factura de ${RFC_VALIDO} no es deducible`), false);
  assertEquals(mensajeEsRfc(`mi rfc es ${RFC_VALIDO}`), false);
  assertEquals(mensajeEsRfc(`${RFC_VALIDO} es mío`), false);
});

Deno.test("mensajeEsRfc: rechaza texto que no tiene forma de RFC", () => {
  assertEquals(mensajeEsRfc("hola"), false);
  assertEquals(mensajeEsRfc(""), false);
  assertEquals(mensajeEsRfc("1234567890123"), false);      // 13 chars, sin letras
  assertEquals(mensajeEsRfc("DAXX8607\n15XX0"), false);    // salto de línea en medio
  assertEquals(mensajeEsRfc("DAXX86071"), false);          // muy corto
  assertEquals(mensajeEsRfc("DAXX860715XX0EXTRA"), false); // muy largo
});

// ---- capturarRfc -------------------------------------------------------------

function clienteConCuentaPendiente() {
  const supabase = new FakeSupabaseClient();
  supabase.tables.users.push({ id: 1, rfc: "PEND41EAF8FF9" });
  return supabase;
}

Deno.test("capturarRfc: guarda el RFC y reporta cuántas facturas reparó", async () => {
  const supabase = clienteConCuentaPendiente();
  // Una factura archivada contra el RFC placeholder, marcada no deducible.
  supabase.tables.invoices.push({
    id: 10, user_id: 1, receptor_rfc: RFC_VALIDO, usuario_rfc: "PEND41EAF8FF9",
    estatus: "advertencia",
    hallazgos: [{ codigo: "RFC_AJENO", severidad: "advertencia", mensaje: "no será deducible" }],
  });

  // deno-lint-ignore no-explicit-any
  const r = await capturarRfc(supabase as any, 1, RFC_VALIDO);
  assertEquals(r.ok, true);
  if (!r.ok) return;
  assertEquals(r.rfc, RFC_VALIDO);
  assertEquals(r.facturasActualizadas, 1);

  // Y la factura dejó de estar marcada como ajena.
  const factura = supabase.tables.invoices[0];
  assertEquals(factura.estatus, "valida");
  assertEquals((factura.hallazgos as unknown[]).length, 0);
  assertEquals(factura.usuario_rfc, RFC_VALIDO);
});

Deno.test("capturarRfc: normaliza a mayúsculas", async () => {
  const supabase = clienteConCuentaPendiente();
  // deno-lint-ignore no-explicit-any
  const r = await capturarRfc(supabase as any, 1, "daxx860715xx0");
  assertEquals(r.ok && r.rfc, RFC_VALIDO);
});

Deno.test("capturarRfc: un RFC de persona moral se distingue de uno inválido", async () => {
  // Son dos problemas distintos y el usuario necesita mensajes distintos:
  // "está mal escrito" vs "ese va en otro lado".
  const supabase = clienteConCuentaPendiente();
  // deno-lint-ignore no-explicit-any
  const r = await capturarRfc(supabase as any, 1, "DJB850527F30");
  assertEquals(r, { ok: false, motivo: "es_moral" });
});

Deno.test("capturarRfc: formato inválido no toca la cuenta", async () => {
  const supabase = clienteConCuentaPendiente();
  // deno-lint-ignore no-explicit-any
  const r = await capturarRfc(supabase as any, 1, "no-es-un-rfc");
  assertEquals(r, { ok: false, motivo: "invalido" });
  assertEquals(supabase.tables.users[0].rfc, "PEND41EAF8FF9");
});

Deno.test("capturarRfc: RFC ya usado por otra cuenta se rechaza", async () => {
  const supabase = clienteConCuentaPendiente();
  supabase.tables.users.push({ id: 2, rfc: RFC_VALIDO });

  // deno-lint-ignore no-explicit-any
  const r = await capturarRfc(supabase as any, 1, RFC_VALIDO);
  assertEquals(r, { ok: false, motivo: "tomado" });
  assertEquals(supabase.tables.users[0].rfc, "PEND41EAF8FF9");
});

// ---- Mensajes ----------------------------------------------------------------

Deno.test("confirmacionRfc: concuerda en singular y plural", () => {
  const uno = confirmacionRfc(RFC_VALIDO, 1);
  assertEquals(uno.includes("1 factura que tenías guardada"), true);
  assertEquals(uno.includes("no deducible."), true);

  const varias = confirmacionRfc(RFC_VALIDO, 3);
  assertEquals(varias.includes("3 facturas que tenías guardadas"), true);
  assertEquals(varias.includes("no deducibles."), true);
});

Deno.test("confirmacionRfc: sin facturas previas no habla de reparar nada", () => {
  const texto = confirmacionRfc(RFC_VALIDO, 0);
  assertEquals(texto.includes("Revisé de nuevo"), false);
  assertEquals(texto.includes(RFC_VALIDO), true);
});

Deno.test("errorCaptura: el mensaje de persona moral dice a dónde SÍ va", () => {
  // Un "RFC inválido" a secas ante un RFC de empresa perfectamente válido
  // dejaría al usuario corrigiendo algo que no está mal.
  assertEquals(errorCaptura("es_moral").includes("Contribuyentes"), true);
});
