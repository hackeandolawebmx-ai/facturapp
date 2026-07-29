/**
 * Tests de la API REST de facturas (Fase M7) — port de las respuestas de
 * `/api/summary`, `/api/invoices`, `/api/invoices/{id}/reclassify` en
 * main.py. Deliberadamente separados de chat.test.ts: son funciones
 * distintas (ver nota de divergencia en invoices_api.ts).
 */
import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import { listInvoicesForUser, reclassifyInvoiceById, summaryForUser } from "./invoices_api.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

function seedInvoice(
  // deno-lint-ignore no-explicit-any
  supabase: any, userId: number, uuid: string,
  total = 1160.0, categoria = "Médicos", anio = 2026,
) {
  supabase.tables.invoices.push({
    id: supabase.tables.invoices.length + 1,
    user_id: userId, uuid_fiscal: uuid, emisor_rfc: "AAA010101AAA",
    emisor_nombre: "Consultorio Dr. X", receptor_rfc: "DAXX860715XX0",
    fecha_emision: "2026-07-12", anio, subtotal: 1000.0, iva: 160.0, total,
    uso_cfdi: "D01", forma_pago: "04", metodo_pago: "PUE",
    clave_prod_principal: "85121800", concepto_descripcion: "Consulta",
    categoria, confianza: 0.9, estatus: "valida", hallazgos: [],
  });
}

// ---- summaryForUser ----------------------------------------------------------

Deno.test("summaryForUser: agrupa por categoría e incluye num_facturas", async () => {
  const supabase = client();
  seedInvoice(supabase, 1, "UUID-A", 1000.0, "Médicos");
  seedInvoice(supabase, 1, "UUID-B", 500.0, "Médicos");
  seedInvoice(supabase, 1, "UUID-C", 200.0, "Colegiaturas");

  const result = await summaryForUser(supabase, 1, 2026);
  assertEquals(result.num_facturas, 3);
  assertEquals(result.categorias["Médicos"], { total: 1500.0, facturas: 2 });
  assertEquals(result.categorias["Colegiaturas"], { total: 200.0, facturas: 1 });
  assertEquals(result.total_general, 1700.0);
});

Deno.test("summaryForUser: aísla por usuario y por año", async () => {
  const supabase = client();
  seedInvoice(supabase, 1, "UUID-A", 1000.0, "Médicos", 2026);
  seedInvoice(supabase, 2, "UUID-B", 9999.0, "Médicos", 2026);
  seedInvoice(supabase, 1, "UUID-C", 500.0, "Médicos", 2025);

  const result = await summaryForUser(supabase, 1, 2026);
  assertEquals(result.num_facturas, 1);
  assertEquals(result.total_general, 1000.0);
});

// ---- listInvoicesForUser ------------------------------------------------------

Deno.test("listInvoicesForUser: devuelve el dict completo de cada factura", async () => {
  const supabase = client();
  seedInvoice(supabase, 1, "UUID-A", 1160.0);

  const result = await listInvoicesForUser(supabase, 1, 2026);
  assertEquals(result.invoices.length, 1);
  assertEquals(result.invoices[0].uuid, "UUID-A");
  assertEquals(result.invoices[0].emisor_rfc, "AAA010101AAA");
  assertEquals(result.invoices[0].hallazgos, []);
});

// ---- reclassifyInvoiceById -----------------------------------------------------

Deno.test("reclassifyInvoiceById: identifica por id numérico, no por uuid", async () => {
  const supabase = client();
  seedInvoice(supabase, 1, "UUID-X", 500, "Sin clasificar");

  const result = await reclassifyInvoiceById(supabase, 1, 1, "Médicos");
  assertEquals(result, { id: 1, categoria: "Médicos" });
  assertEquals(supabase.tables.invoices[0].categoria, "Médicos");
  assertEquals(supabase.tables.invoices[0].confianza, 1.0);
});

Deno.test("reclassifyInvoiceById: factura de otro usuario devuelve null (404)", async () => {
  const supabase = client();
  seedInvoice(supabase, 2, "UUID-X", 500);

  const result = await reclassifyInvoiceById(supabase, 1, 1, "Médicos");
  assertEquals(result, null);
});
