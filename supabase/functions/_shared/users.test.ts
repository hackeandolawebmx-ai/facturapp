/**
 * Tests de resolución de usuario por teléfono (Fase M4) y por email (Fase M5).
 *
 * Usa FakeSupabaseClient (en memoria) — NO es Postgres real. Ver
 * fake_supabase_client.ts para el alcance exacto de la simulación.
 */
import { assertEquals } from "@std/assert";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import { getOrCreateUserByEmail, getOrCreateUserByPhone, getUserByWebToken, getUserProfile } from "./users.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

Deno.test("getOrCreateUserByPhone: crea cuenta mínima si el teléfono no existe", async () => {
  const supabase = client();
  const user = await getOrCreateUserByPhone(supabase, "5215512345678", "Cliente Nuevo");

  assertEquals(typeof user.id, "number");
  assertEquals(user.rfc.startsWith("PEND"), true);

  const row = supabase.tables.users.find((u: Record<string, unknown>) => u.id === user.id);
  assertEquals(row.whatsapp_phone, "5215512345678");
  assertEquals(row.nombre, "Cliente Nuevo");
  assertEquals(row.email, "wa-5215512345678@facturapp.mx");
});

Deno.test("getOrCreateUserByPhone: reutiliza la cuenta si el teléfono ya existe", async () => {
  const supabase = client();
  const first = await getOrCreateUserByPhone(supabase, "5215512345678", "Primera Vez");
  const second = await getOrCreateUserByPhone(supabase, "5215512345678", "Otro Nombre");

  assertEquals(first.id, second.id);
  assertEquals(supabase.tables.users.length, 1); // no duplicó la cuenta
});

Deno.test("getOrCreateUserByPhone: sin profileName usa el teléfono como nombre", async () => {
  const supabase = client();
  await getOrCreateUserByPhone(supabase, "5215500000000", null);
  const row = supabase.tables.users[0];
  assertEquals(row.nombre, "5215500000000");
});

// ---- getOrCreateUserByEmail (Fase M5) ---------------------------------------

Deno.test("getOrCreateUserByEmail: crea cuenta mínima si el email no existe", async () => {
  const supabase = client();
  const user = await getOrCreateUserByEmail(supabase, "nueva@example.com");

  assertEquals(typeof user.id, "number");
  assertEquals(user.rfc.startsWith("PEND"), true);

  const row = supabase.tables.users.find((u: Record<string, unknown>) => u.id === user.id);
  assertEquals(row.email, "nueva@example.com");
  assertEquals(row.nombre, "nueva"); // derivado de la parte local del email
});

Deno.test("getOrCreateUserByEmail: reutiliza la cuenta si el email ya existe", async () => {
  const supabase = client();
  const first = await getOrCreateUserByEmail(supabase, "recurrente@example.com");
  const second = await getOrCreateUserByEmail(supabase, "recurrente@example.com");

  assertEquals(first.id, second.id);
  assertEquals(supabase.tables.users.length, 1);
});

Deno.test("getOrCreateUserByEmail: normaliza a minúsculas antes de buscar/crear", async () => {
  const supabase = client();
  const created = await getOrCreateUserByEmail(supabase, "Mayus@Example.com");
  const found = await getOrCreateUserByEmail(supabase, "mayus@example.com");
  assertEquals(created.id, found.id);
});

// ---- getUserProfile / getUserByWebToken (Fase M7) ---------------------------

Deno.test("getUserProfile: devuelve el perfil completo por id", async () => {
  const supabase = client();
  supabase.tables.users.push({
    id: 1, email: "daniela@example.com", nombre: "Daniela Ávila",
    rfc: "DAXX860715XX0", plan: "free", web_token: "TOKEN123", whatsapp_phone: null,
  });

  const profile = await getUserProfile(supabase, 1);
  assertEquals(profile, {
    id: 1, email: "daniela@example.com", nombre: "Daniela Ávila",
    rfc: "DAXX860715XX0", plan: "free", web_token: "TOKEN123", whatsapp_phone: null,
  });
});

Deno.test("getUserProfile: usuario inexistente devuelve null", async () => {
  const supabase = client();
  assertEquals(await getUserProfile(supabase, 999), null);
});

Deno.test("getUserByWebToken: resuelve por token válido", async () => {
  const supabase = client();
  supabase.tables.users.push({
    id: 1, email: "daniela@example.com", nombre: "Daniela Ávila",
    rfc: "DAXX860715XX0", plan: "free", web_token: "TOKEN123", whatsapp_phone: null,
  });

  const user = await getUserByWebToken(supabase, "TOKEN123");
  assertEquals(user?.id, 1);
});

Deno.test("getUserByWebToken: token inválido devuelve null", async () => {
  const supabase = client();
  assertEquals(await getUserByWebToken(supabase, "no-existe"), null);
});
