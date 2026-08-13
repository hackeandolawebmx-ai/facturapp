/**
 * Tests de la ingesta compartida (Fase M4).
 *
 * anioDeFecha es lógica pura, testeada de verdad. ingestInvoice hace I/O a
 * BD — se testea contra FakeSupabaseClient (en memoria), NO Postgres real.
 * El smoke test manual post-deploy (ver README) es lo que valida el INSERT
 * real contra el esquema `facturapp` verdadero.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { anioDeFecha, ingestInvoice } from "./invoices.ts";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";

const testdata = (name: string) =>
  Deno.readTextFileSync(new URL(`./testdata/${name}`, import.meta.url));

// deno-lint-ignore no-explicit-any
function clientWithUser(userId = 1, rfc = "DAXX860715XX0"): any {
  const c = new FakeSupabaseClient();
  c.tables.users.push({ id: userId, rfc, whatsapp_phone: "5215512345678" });
  return c;
}

// ---- anioDeFecha ------------------------------------------------------------

Deno.test("anioDeFecha: extrae el año de YYYY-MM-DD", () => {
  assertEquals(anioDeFecha("2026-07-12"), 2026);
});

Deno.test("anioDeFecha: string vacío cae al año actual (no NaN)", () => {
  assertEquals(Number.isNaN(anioDeFecha("")), false);
});

// ---- ingestInvoice -----------------------------------------------------------

Deno.test("ingestInvoice: XML válido se guarda con estatus 200", async () => {
  const supabase = clientWithUser();
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode(testdata("valido.xml"));

  const result = await ingestInvoice(supabase, user, contenido, "factura.xml", "web");

  assertEquals(result.status_code, 200);
  // El RFC del usuario de prueba (DAXX860715XX0) SÍ coincide con el receptor
  // del CFDI de seed → sin RFC_AJENO. La factura queda "valida".
  assertEquals(result.estatus, "valida");
  assertEquals(supabase.tables.invoices.length, 1);
  assertEquals(supabase.tables.invoices[0].uuid_fiscal, result.uuid);
  assertEquals(supabase.tables.invoices[0].categoria, "Médicos");
});

Deno.test("ingestInvoice: contenido PDF da 202 y NO se guarda", async () => {
  const supabase = clientWithUser();
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode("%PDF-1.4 contenido falso");

  const result = await ingestInvoice(supabase, user, contenido, "factura.pdf", "web");

  assertEquals(result.status_code, 202);
  assertEquals(result.estatus, "por_revisar");
  assertEquals(supabase.tables.invoices.length, 0);
});

Deno.test("ingestInvoice: XML mal formado da 422 y NO se guarda", async () => {
  const supabase = clientWithUser();
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode("<esto no es xml valido>");

  const result = await ingestInvoice(supabase, user, contenido, "factura.xml", "web");

  assertEquals(result.status_code, 422);
  assertEquals(result.estatus, "rechazada");
  assertEquals(supabase.tables.invoices.length, 0);
});

Deno.test("ingestInvoice: UUID duplicado se rechaza y NO se guarda de nuevo", async () => {
  const supabase = clientWithUser();
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode(testdata("valido.xml"));

  const primero = await ingestInvoice(supabase, user, contenido, "factura.xml", "web");
  assertEquals(primero.status_code, 200);
  assertEquals(supabase.tables.invoices.length, 1);

  const segundo = await ingestInvoice(supabase, user, contenido, "factura.xml", "web");
  assertEquals(segundo.estatus, "rechazada");
  assertEquals(segundo.hallazgos[0].codigo, "UUID_DUPLICADO");
  assertEquals(supabase.tables.invoices.length, 1); // no se duplicó
});

// ---- Personas morales (Fase M14) --------------------------------------------
//
// El motor implementa deducciones personales. Aplicarlo a una empresa
// produciría consejo falso: marcaría el uso G03 —el correcto para una
// moral— como "uso de CFDI incorrecto, pide corrección al emisor".

/** La misma factura de prueba: receptor DAXX860715XX0. */
const xmlValido = () => new TextEncoder().encode(testdata("valido.xml"));

// deno-lint-ignore no-explicit-any
function conRfcDeCuenta(supabase: any, rfc: string, tipo: string) {
  supabase.tables.user_rfcs.push({
    id: 1, user_id: 1, rfc, tipo, alias: null, es_principal: tipo === "fisica",
  });
}

Deno.test("ingestInvoice: factura de un RFC moral se archiva sin clasificar", async () => {
  const supabase = clientWithUser(1, "AUCD870504PU0");
  conRfcDeCuenta(supabase, "DAXX860715XX0", "moral");

  const result = await ingestInvoice(
    supabase, supabase.tables.users[0], xmlValido(), "factura.xml", "web",
  );

  assertEquals(result.estatus, "archivada");
  assertEquals(result.categoria, undefined);
  assertEquals(result.hallazgos.map((h: { codigo: string }) => h.codigo), ["PERSONA_MORAL"]);
  // Se guarda: conservar el comprobante es justamente el punto.
  assertEquals(supabase.tables.invoices.length, 1);
});

Deno.test("ingestInvoice: el archivado explica por qué, no calla", async () => {
  // Sin el mensaje, la ausencia de advertencias se leería como "todo en
  // orden" y la falta de categoría como un fallo del clasificador.
  const supabase = clientWithUser(1, "AUCD870504PU0");
  conRfcDeCuenta(supabase, "DAXX860715XX0", "moral");

  const result = await ingestInvoice(
    supabase, supabase.tables.users[0], xmlValido(), "factura.xml", "web",
  );
  assertEquals(result.hallazgos[0].mensaje.includes("morales"), true);
});

Deno.test("ingestInvoice: el MISMO XML en un RFC físico sí se clasifica", async () => {
  // Contraste directo: el tratamiento depende del tipo de contribuyente, no
  // de la factura.
  const supabase = clientWithUser(1, "DAXX860715XX0");
  conRfcDeCuenta(supabase, "DAXX860715XX0", "fisica");

  const result = await ingestInvoice(
    supabase, supabase.tables.users[0], xmlValido(), "factura.xml", "web",
  );
  assertEquals(result.estatus, "valida");
  assertEquals(result.categoria, "Médicos");
});

Deno.test("ingestInvoice: sin RFCs dados de alta se conserva el comportamiento previo", async () => {
  // Cuentas anteriores a M14, o recién creadas con RFC `PEND...`.
  const supabase = clientWithUser(1, "DAXX860715XX0");

  const result = await ingestInvoice(
    supabase, supabase.tables.users[0], xmlValido(), "factura.xml", "web",
  );
  assertEquals(result.estatus, "valida");
  assertEquals(result.categoria, "Médicos");
});

Deno.test("ingestInvoice: RFC ajeno da advertencia pero SÍ se guarda", async () => {
  // Usuario con un RFC que NO coincide con el receptor del CFDI de seed.
  const supabase = clientWithUser(1, "REBB900110AB1");
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode(testdata("valido.xml"));

  const result = await ingestInvoice(supabase, user, contenido, "factura.xml", "web");

  assertEquals(result.estatus, "advertencia");
  assertEquals(result.hallazgos[0].codigo, "RFC_AJENO");
  assertEquals(supabase.tables.invoices.length, 1); // advertencia SÍ se guarda
});
