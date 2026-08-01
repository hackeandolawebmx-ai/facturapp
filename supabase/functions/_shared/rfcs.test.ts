/**
 * Tests de los RFCs de una cuenta (Fase M14).
 *
 * Lo que se prueba aquí no es CRUD: es la decisión de la que depende si a una
 * factura se le aplican reglas de deducción personal. Equivocarse produce
 * consejo fiscal falso — decirle a una empresa que su uso G03 está mal.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import {
  agregarRfc, eliminarRfc, listarRfcs, type RfcDeCuenta, rfcQueRecibe,
  sincronizarRfcPrincipal,
} from "./rfcs.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

// deno-lint-ignore no-explicit-any
function conRfc(supabase: any, id: number, userId: number, rfc: string,
                tipo: string, principal = false) {
  supabase.tables.user_rfcs.push({
    id, user_id: userId, rfc, tipo, alias: null, es_principal: principal,
  });
}

const FISICA: RfcDeCuenta = {
  id: 1, rfc: "AUCD870504PU0", tipo: "fisica", alias: null, es_principal: true,
};
const MORAL: RfcDeCuenta = {
  id: 2, rfc: "ABC010101AB1", tipo: "moral", alias: "Mi empresa", es_principal: false,
};

// ---- rfcQueRecibe: la decisión que importa ---------------------------------

Deno.test("rfcQueRecibe: encuentra el RFC físico al que va dirigida", () => {
  assertEquals(rfcQueRecibe([FISICA, MORAL], "AUCD870504PU0")?.tipo, "fisica");
});

Deno.test("rfcQueRecibe: encuentra el RFC moral y lo identifica como tal", () => {
  // De esto depende que NO se le apliquen las reglas de deducción personal.
  assertEquals(rfcQueRecibe([FISICA, MORAL], "ABC010101AB1")?.tipo, "moral");
});

Deno.test("rfcQueRecibe: compara sin distinguir mayúsculas", () => {
  // Los PAC no son consistentes en esto.
  assertEquals(rfcQueRecibe([FISICA], "aucd870504pu0")?.id, 1);
});

Deno.test("rfcQueRecibe: ignora espacios alrededor", () => {
  assertEquals(rfcQueRecibe([FISICA], "  AUCD870504PU0 ")?.id, 1);
});

Deno.test("rfcQueRecibe: un RFC ajeno devuelve null", () => {
  assertEquals(rfcQueRecibe([FISICA, MORAL], "XAXX010101000"), null);
});

Deno.test("rfcQueRecibe: receptor vacío devuelve null, no coincide por accidente", () => {
  assertEquals(rfcQueRecibe([FISICA], ""), null);
});

Deno.test("rfcQueRecibe: sin RFCs dados de alta devuelve null", () => {
  assertEquals(rfcQueRecibe([], "AUCD870504PU0"), null);
});

// ---- Alta y baja ------------------------------------------------------------

Deno.test("listarRfcs: devuelve los de la cuenta, principal primero", async () => {
  const supabase = client();
  conRfc(supabase, 1, 7, "ABC010101AB1", "moral");
  conRfc(supabase, 2, 7, "AUCD870504PU0", "fisica", true);

  const rfcs = await listarRfcs(supabase, 7);
  assertEquals(rfcs.length, 2);
  assertEquals(rfcs[0].es_principal, true);
});

Deno.test("listarRfcs: no devuelve los de otra cuenta", async () => {
  const supabase = client();
  conRfc(supabase, 1, 99, "ABC010101AB1", "moral");
  assertEquals((await listarRfcs(supabase, 7)).length, 0);
});

Deno.test("agregarRfc: da de alta uno nuevo como no principal", async () => {
  const supabase = client();
  conRfc(supabase, 1, 7, "AUCD870504PU0", "fisica", true);

  const creado = await agregarRfc(supabase, 7, "ABC010101AB1", "moral", "Mi empresa");
  assertEquals(creado?.rfc, "ABC010101AB1");
  assertEquals(creado?.tipo, "moral");
  assertEquals(creado?.es_principal, false);
});

Deno.test("agregarRfc: repetido en la misma cuenta devuelve null", async () => {
  const supabase = client();
  conRfc(supabase, 1, 7, "ABC010101AB1", "moral");
  assertEquals(await agregarRfc(supabase, 7, "ABC010101AB1", "moral", null), null);
});

Deno.test("eliminarRfc: quita uno secundario", async () => {
  const supabase = client();
  conRfc(supabase, 1, 7, "AUCD870504PU0", "fisica", true);
  conRfc(supabase, 2, 7, "ABC010101AB1", "moral");

  assertEquals((await eliminarRfc(supabase, 7, 2)).ok, true);
  assertEquals(supabase.tables.user_rfcs.length, 1);
});

Deno.test("eliminarRfc: el principal NO se puede eliminar", async () => {
  // Vive también en users.rfc y lo usan el resto de los endpoints por
  // defecto; quitarlo dejaría la cuenta incoherente.
  const supabase = client();
  conRfc(supabase, 1, 7, "AUCD870504PU0", "fisica", true);

  const r = await eliminarRfc(supabase, 7, 1);
  assertEquals(r.ok, false);
  assertEquals(r.motivo, "es_principal");
  assertEquals(supabase.tables.user_rfcs.length, 1);
});

Deno.test("eliminarRfc: el de otra cuenta no se toca", async () => {
  const supabase = client();
  conRfc(supabase, 1, 99, "ABC010101AB1", "moral");

  const r = await eliminarRfc(supabase, 7, 1);
  assertEquals(r.ok, false);
  assertEquals(r.motivo, "no_encontrado");
  assertEquals(supabase.tables.user_rfcs.length, 1);
});

// ---- sincronizarRfcPrincipal (Fase M15) -------------------------------------
//
// updateUserRfc() (perfil, M11) y auth-register (M7) tocan users.rfc
// directamente y nunca escribieron en user_rfcs. Sin esto, listarRfcs()
// queda vacío para la mayoría de las cuentas reales pese a tener un RFC
// válido — solo el resumen por contribuyente (M15) lo hizo visible.

Deno.test("sincronizarRfcPrincipal: crea el principal si la cuenta no tiene ninguno", async () => {
  const supabase = client();
  await sincronizarRfcPrincipal(supabase, 7, "AUCD870504PU0");

  const rfcs = await listarRfcs(supabase, 7);
  assertEquals(rfcs.length, 1);
  assertEquals(rfcs[0].rfc, "AUCD870504PU0");
  assertEquals(rfcs[0].tipo, "fisica");
  assertEquals(rfcs[0].es_principal, true);
});

Deno.test("sincronizarRfcPrincipal: no le pone el alias 'Principal' (queda null)", async () => {
  // A diferencia del backfill de la migración 0008, que sí lo hacía --
  // redundante con la etiqueta que ya muestra la interfaz vía es_principal.
  const supabase = client();
  await sincronizarRfcPrincipal(supabase, 7, "AUCD870504PU0");

  assertEquals((await listarRfcs(supabase, 7))[0].alias, null);
});

Deno.test("sincronizarRfcPrincipal: actualiza el principal existente en vez de duplicar", async () => {
  const supabase = client();
  conRfc(supabase, 1, 7, "AUCD870504PU0", "fisica", true);

  await sincronizarRfcPrincipal(supabase, 7, "NUEVORFC010101AB1");

  const rfcs = await listarRfcs(supabase, 7);
  assertEquals(rfcs.length, 1);
  assertEquals(rfcs[0].rfc, "NUEVORFC010101AB1");
  assertEquals(rfcs[0].es_principal, true);
});

Deno.test("sincronizarRfcPrincipal: no toca los RFCs secundarios de la cuenta", async () => {
  const supabase = client();
  conRfc(supabase, 1, 7, "AUCD870504PU0", "fisica", true);
  conRfc(supabase, 2, 7, "ABC010101AB1", "moral");

  await sincronizarRfcPrincipal(supabase, 7, "OTRORFC020202CD2");

  const rfcs = await listarRfcs(supabase, 7);
  assertEquals(rfcs.length, 2);
  assertEquals(rfcs.some((r) => r.rfc === "ABC010101AB1" && r.tipo === "moral"), true);
});

Deno.test("sincronizarRfcPrincipal: no afecta cuentas de otros usuarios", async () => {
  const supabase = client();
  conRfc(supabase, 1, 99, "AUCD870504PU0", "fisica", true);

  await sincronizarRfcPrincipal(supabase, 7, "NUEVORFC010101AB1");

  assertEquals((await listarRfcs(supabase, 99))[0].rfc, "AUCD870504PU0");
  assertEquals((await listarRfcs(supabase, 7))[0].rfc, "NUEVORFC010101AB1");
});
