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

  const result = await ingestInvoice(supabase, user, contenido, "factura.xml");

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

  const result = await ingestInvoice(supabase, user, contenido, "factura.pdf");

  assertEquals(result.status_code, 202);
  assertEquals(result.estatus, "por_revisar");
  assertEquals(supabase.tables.invoices.length, 0);
});

Deno.test("ingestInvoice: XML mal formado da 422 y NO se guarda", async () => {
  const supabase = clientWithUser();
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode("<esto no es xml valido>");

  const result = await ingestInvoice(supabase, user, contenido, "factura.xml");

  assertEquals(result.status_code, 422);
  assertEquals(result.estatus, "rechazada");
  assertEquals(supabase.tables.invoices.length, 0);
});

Deno.test("ingestInvoice: UUID duplicado se rechaza y NO se guarda de nuevo", async () => {
  const supabase = clientWithUser();
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode(testdata("valido.xml"));

  const primero = await ingestInvoice(supabase, user, contenido, "factura.xml");
  assertEquals(primero.status_code, 200);
  assertEquals(supabase.tables.invoices.length, 1);

  const segundo = await ingestInvoice(supabase, user, contenido, "factura.xml");
  assertEquals(segundo.estatus, "rechazada");
  assertEquals(segundo.hallazgos[0].codigo, "UUID_DUPLICADO");
  assertEquals(supabase.tables.invoices.length, 1); // no se duplicó
});

Deno.test("ingestInvoice: RFC ajeno da advertencia pero SÍ se guarda", async () => {
  // Usuario con un RFC que NO coincide con el receptor del CFDI de seed.
  const supabase = clientWithUser(1, "REBB900110AB1");
  const user = supabase.tables.users[0];
  const contenido = new TextEncoder().encode(testdata("valido.xml"));

  const result = await ingestInvoice(supabase, user, contenido, "factura.xml");

  assertEquals(result.estatus, "advertencia");
  assertEquals(result.hallazgos[0].codigo, "RFC_AJENO");
  assertEquals(supabase.tables.invoices.length, 1); // advertencia SÍ se guarda
});
