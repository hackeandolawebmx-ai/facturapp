/**
 * Tests de resolución de usuario por teléfono (Fase M4) y por email (Fase M5).
 *
 * Usa FakeSupabaseClient (en memoria) — NO es Postgres real. Ver
 * fake_supabase_client.ts para el alcance exacto de la simulación.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import {
  getOrCreateUserByEmail, getOrCreateUserByPhone, getUserByWebToken, getUserProfile,
  revalidarFacturasTrasCambioDeRfc, rfcTomadoPorOtro, updateUserRfc,
} from "./users.ts";

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

// ---- updateUserRfc / rfcTomadoPorOtro (Fase M11) ----------------------------
//
// Sin esto, una cuenta creada por WhatsApp o correo se queda con su RFC
// sintético `PEND...` para siempre, y TODA su facturación sale marcada como
// no deducible. Es el camino que accounts.py daba por existente y no existía.

// deno-lint-ignore no-explicit-any
function conUsuario(supabase: any, id: number, rfc: string, email = `u${id}@x.com`) {
  supabase.tables.users.push({
    id, email, nombre: `Usuario ${id}`, rfc, plan: "free",
    web_token: `TOKEN${id}`, whatsapp_phone: null,
  });
}

Deno.test("updateUserRfc: reemplaza el RFC sintético y devuelve el perfil", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "PEND5AE3C89EC");

  const perfil = await updateUserRfc(supabase, 1, "AUCD870504PU0");
  assertEquals(perfil?.rfc, "AUCD870504PU0");
  assertEquals(supabase.tables.users[0].rfc, "AUCD870504PU0");
});

Deno.test("updateUserRfc: usuario inexistente devuelve null", async () => {
  const supabase = client();
  assertEquals(await updateUserRfc(supabase, 999, "AUCD870504PU0"), null);
});

Deno.test("updateUserRfc: no toca a los demás usuarios", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "PEND111111111");
  conUsuario(supabase, 2, "PEND222222222");

  await updateUserRfc(supabase, 1, "AUCD870504PU0");
  assertEquals(supabase.tables.users[1].rfc, "PEND222222222");
});

Deno.test("rfcTomadoPorOtro: detecta un RFC ya usado por otra cuenta", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "PEND111111111");
  conUsuario(supabase, 2, "AUCD870504PU0");

  assertEquals(await rfcTomadoPorOtro(supabase, 1, "AUCD870504PU0"), true);
});

Deno.test("rfcTomadoPorOtro: el propio RFC del usuario no cuenta como tomado", async () => {
  // Reguardar el mismo RFC no debe fallar; sin el neq() sobre el propio id,
  // el usuario se bloquearía a sí mismo.
  const supabase = client();
  conUsuario(supabase, 1, "AUCD870504PU0");

  assertEquals(await rfcTomadoPorOtro(supabase, 1, "AUCD870504PU0"), false);
});

Deno.test("rfcTomadoPorOtro: un RFC libre devuelve false", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "PEND111111111");

  assertEquals(await rfcTomadoPorOtro(supabase, 1, "XAXX010101000"), false);
});

// ---- revalidarFacturasTrasCambioDeRfc ---------------------------------------

// deno-lint-ignore no-explicit-any
function conFactura(supabase: any, id: number, userId: number, receptorRfc: string,
                    estatus: string, hallazgos: unknown[]) {
  supabase.tables.invoices.push({
    id, user_id: userId, receptor_rfc: receptorRfc, estatus, hallazgos,
  });
}

const HALLAZGO_AJENO = {
  codigo: "RFC_AJENO", severidad: "advertencia",
  mensaje: "Factura emitida a RFC AUCD870504PU0; no será deducible",
};

Deno.test("revalidar: limpia la advertencia de las facturas que ya son del usuario", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "AUCD870504PU0");
  conFactura(supabase, 10, 1, "AUCD870504PU0", "advertencia", [HALLAZGO_AJENO]);

  const cambiadas = await revalidarFacturasTrasCambioDeRfc(supabase, 1, "AUCD870504PU0");
  assertEquals(cambiadas, 1);
  assertEquals(supabase.tables.invoices[0].estatus, "valida");
  assertEquals(supabase.tables.invoices[0].hallazgos.length, 0);
});

Deno.test("revalidar: no toca facturas realmente emitidas a otro RFC", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "AUCD870504PU0");
  conFactura(supabase, 10, 1, "XAXX010101000", "advertencia", [HALLAZGO_AJENO]);

  const cambiadas = await revalidarFacturasTrasCambioDeRfc(supabase, 1, "AUCD870504PU0");
  assertEquals(cambiadas, 0);
  assertEquals(supabase.tables.invoices[0].estatus, "advertencia");
});

Deno.test("revalidar: no toca las facturas de otros usuarios", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "AUCD870504PU0");
  conFactura(supabase, 10, 2, "AUCD870504PU0", "advertencia", [HALLAZGO_AJENO]);

  const cambiadas = await revalidarFacturasTrasCambioDeRfc(supabase, 1, "AUCD870504PU0");
  assertEquals(cambiadas, 0);
  assertEquals(supabase.tables.invoices[0].estatus, "advertencia");
});

Deno.test("revalidar: sin facturas no falla y devuelve 0", async () => {
  const supabase = client();
  conUsuario(supabase, 1, "AUCD870504PU0");
  assertEquals(await revalidarFacturasTrasCambioDeRfc(supabase, 1, "AUCD870504PU0"), 0);
});
