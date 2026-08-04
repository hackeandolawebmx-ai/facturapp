/**
 * Tests de `facturasQueNecesitanAtencion` (Fase M20).
 *
 * Lo que importa probar: qué estatus cuentan como "necesita atención" (y que
 * `archivada`/`valida` NO cuenten), que el filtro es por mes de EMISIÓN, y
 * que respeta aislamiento por usuario y por RFC.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import { facturasQueNecesitanAtencion } from "./attention.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

// deno-lint-ignore no-explicit-any
function conFactura(supabase: any, over: Record<string, unknown>) {
  supabase.tables.invoices.push(Object.assign({
    id: supabase.tables.invoices.length + 1,
    user_id: 7, emisor_rfc: "AAA010101AAA", emisor_nombre: "Consultorio X",
    receptor_rfc: "DAXX860715XX0", usuario_rfc: "DAXX860715XX0",
    fecha_emision: "2026-08-15", anio: 2026, subtotal: 1000, iva: 160, total: 1160,
    categoria: "Médicos", confianza: 0.9, estatus: "valida", hallazgos: [],
  }, over));
}

Deno.test("facturasQueNecesitanAtencion: incluye advertencia, por_revisar y rechazada", async () => {
  const supabase = client();
  conFactura(supabase, { estatus: "advertencia" });
  conFactura(supabase, { estatus: "por_revisar" });
  conFactura(supabase, { estatus: "rechazada" });

  const r = await facturasQueNecesitanAtencion(supabase, 7, 2026, 8);
  assertEquals(r.length, 3);
});

Deno.test("facturasQueNecesitanAtencion: excluye válida", async () => {
  const supabase = client();
  conFactura(supabase, { estatus: "valida" });
  assertEquals((await facturasQueNecesitanAtencion(supabase, 7, 2026, 8)).length, 0);
});

Deno.test("facturasQueNecesitanAtencion: excluye archivada (persona moral, fuera de alcance)", async () => {
  const supabase = client();
  conFactura(supabase, { estatus: "archivada" });
  assertEquals((await facturasQueNecesitanAtencion(supabase, 7, 2026, 8)).length, 0);
});

Deno.test("facturasQueNecesitanAtencion: filtra por mes de emisión, no por otros meses", async () => {
  const supabase = client();
  conFactura(supabase, { estatus: "advertencia", fecha_emision: "2026-07-30" });
  conFactura(supabase, { estatus: "advertencia", fecha_emision: "2026-08-01" });
  conFactura(supabase, { estatus: "advertencia", fecha_emision: "2026-09-01" });

  const r = await facturasQueNecesitanAtencion(supabase, 7, 2026, 8);
  assertEquals(r.length, 1);
  assertEquals(r[0].fecha_emision, "2026-08-01");
});

Deno.test("facturasQueNecesitanAtencion: no mezcla facturas de otro usuario", async () => {
  const supabase = client();
  conFactura(supabase, { estatus: "advertencia", user_id: 99 });
  assertEquals((await facturasQueNecesitanAtencion(supabase, 7, 2026, 8)).length, 0);
});

Deno.test("facturasQueNecesitanAtencion: con rfc filtra solo las de ese contribuyente", async () => {
  const supabase = client();
  conFactura(supabase, { estatus: "advertencia", usuario_rfc: "DAXX860715XX0" });
  conFactura(supabase, { estatus: "advertencia", usuario_rfc: "OTRO010101AB1" });

  const r = await facturasQueNecesitanAtencion(supabase, 7, 2026, 8, "OTRO010101AB1");
  assertEquals(r.length, 1);
  assertEquals(r[0].estatus, "advertencia");
});

Deno.test("facturasQueNecesitanAtencion: sin coincidencias devuelve []", async () => {
  const supabase = client();
  assertEquals(await facturasQueNecesitanAtencion(supabase, 7, 2026, 8), []);
});
