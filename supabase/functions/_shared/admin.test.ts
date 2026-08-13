/**
 * Tests del back-office (Fase M23).
 *
 * Se prueban las GUARDAS de `cambiarEstadoCuenta`, que es donde vive la lógica
 * con consecuencias: suspender mal deja a alguien sin servicio, y suspender al
 * operador equivocado deja el panel sin nadie que pueda entrar a deshacerlo.
 *
 * `listarCuentas` y `obtenerMetricas` NO se prueban aquí: son envoltorios
 * finos sobre una vista y una función de Postgres, y usan `.or()`, `.ilike()`,
 * `.range()` y `.rpc()`, que el FakeSupabaseClient no implementa. Fingir esos
 * métodos en el fake probaría el fake, no el sistema -- se validan en el smoke
 * test manual contra Postgres real, igual que el resto de la orquestación
 * (ver la nota de fake_supabase_client.ts).
 */
import { assertEquals } from "jsr:@std/assert@1";
import { cambiarEstadoCuenta } from "./admin.ts";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";

function client() {
  return new FakeSupabaseClient();
}

const ADMIN_ID = 1;

Deno.test("cambiarEstadoCuenta: suspender marca la fecha y guarda el motivo", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 7, rol: "usuario", suspendida_en: null });

  // deno-lint-ignore no-explicit-any
  const r = await cambiarEstadoCuenta(supabase as any, ADMIN_ID, 7, "suspender", "spam");
  assertEquals(r, { ok: true, suspendida: true });

  const fila = supabase.tables.users[0];
  assertEquals(fila.suspendida_motivo, "spam");
  assertEquals(typeof fila.suspendida_en, "string");
});

Deno.test("cambiarEstadoCuenta: reactivar limpia fecha Y motivo", async () => {
  // El motivo se limpia a propósito: si se conservara, la siguiente suspensión
  // heredaría la razón de la anterior y el panel mostraría un motivo falso.
  const supabase = client();
  supabase.tables.users.push({
    id: 7, rol: "usuario", suspendida_en: "2026-08-13T00:00:00Z", suspendida_motivo: "spam",
  });

  // deno-lint-ignore no-explicit-any
  const r = await cambiarEstadoCuenta(supabase as any, ADMIN_ID, 7, "reactivar", null);
  assertEquals(r, { ok: true, suspendida: false });

  const fila = supabase.tables.users[0];
  assertEquals(fila.suspendida_en, null);
  assertEquals(fila.suspendida_motivo, null);
});

Deno.test("cambiarEstadoCuenta: NO deja suspenderse a uno mismo", async () => {
  // Sería irreversible desde la interfaz: al quedar suspendido, getCurrentAdmin
  // devuelve null y ya no hay forma de entrar al panel para deshacerlo.
  const supabase = client();
  supabase.tables.users.push({ id: ADMIN_ID, rol: "admin", suspendida_en: null });

  // deno-lint-ignore no-explicit-any
  const r = await cambiarEstadoCuenta(supabase as any, ADMIN_ID, ADMIN_ID, "suspender", null);
  assertEquals(r, { ok: false, motivo: "es_uno_mismo" });
  // Y la fila no se tocó.
  assertEquals(supabase.tables.users[0].suspendida_en, null);
});

Deno.test("cambiarEstadoCuenta: NO deja suspender a otro admin", async () => {
  const supabase = client();
  supabase.tables.users.push({ id: 9, rol: "admin", suspendida_en: null });

  // deno-lint-ignore no-explicit-any
  const r = await cambiarEstadoCuenta(supabase as any, ADMIN_ID, 9, "suspender", null);
  assertEquals(r, { ok: false, motivo: "es_admin" });
  assertEquals(supabase.tables.users[0].suspendida_en, null);
});

Deno.test("cambiarEstadoCuenta: cuenta inexistente", async () => {
  const supabase = client();
  // deno-lint-ignore no-explicit-any
  const r = await cambiarEstadoCuenta(supabase as any, ADMIN_ID, 404, "suspender", null);
  assertEquals(r, { ok: false, motivo: "no_encontrada" });
});

Deno.test("cambiarEstadoCuenta: la guarda de 'uno mismo' se aplica antes de leer la base", async () => {
  // Sin filas en la tabla: si la guarda se evaluara después del SELECT, esto
  // devolvería "no_encontrada" en vez de "es_uno_mismo". El orden importa
  // porque el mensaje que ve el operador debe explicar la razón real.
  const supabase = client();
  // deno-lint-ignore no-explicit-any
  const r = await cambiarEstadoCuenta(supabase as any, ADMIN_ID, ADMIN_ID, "suspender", null);
  assertEquals(r, { ok: false, motivo: "es_uno_mismo" });
});
