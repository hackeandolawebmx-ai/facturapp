/**
 * Tests del rate limiting (Fase M8).
 *
 * La lógica de conteo vive en Postgres (`facturapp.registrar_intento`), no
 * aquí — está ahí justo porque necesita ser atómica, y reimplementarla en
 * TypeScript solo probaría la reimplementación. Lo que se prueba aquí es la
 * parte que sí es nuestra: extraer la IP de los headers del proxy, componer
 * las claves, y reaccionar correctamente a cada respuesta posible de la BD.
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";
import { ipDelCliente, permitirIntentoDeLogin, registrarIntento } from "./rate_limit.ts";

// deno-lint-ignore no-explicit-any
function client(): any {
  return new FakeSupabaseClient();
}

// ---- ipDelCliente -----------------------------------------------------------

Deno.test("ipDelCliente: usa x-forwarded-for cuando está presente", () => {
  const h = new Headers({ "x-forwarded-for": "189.175.190.48" });
  assertEquals(ipDelCliente(h), "189.175.190.48");
});

Deno.test("ipDelCliente: con cadena de proxies toma el primer elemento (el cliente)", () => {
  const h = new Headers({ "x-forwarded-for": "189.175.190.48, 10.0.0.1, 172.16.0.5" });
  assertEquals(ipDelCliente(h), "189.175.190.48");
});

Deno.test("ipDelCliente: cae a cf-connecting-ip si no hay x-forwarded-for", () => {
  const h = new Headers({ "cf-connecting-ip": "173.252.69.4" });
  assertEquals(ipDelCliente(h), "173.252.69.4");
});

Deno.test("ipDelCliente: sin ningún header devuelve 'desconocida', no vacío", () => {
  // Importa que no sea "" : una clave vacía agruparía distinto que una
  // etiqueta explícita, y aquí queremos que todos los clientes sin IP caigan
  // en la MISMA cubeta (limitar de más, no de menos).
  assertEquals(ipDelCliente(new Headers()), "desconocida");
});

// ---- registrarIntento --------------------------------------------------------

Deno.test("registrarIntento: pasa los parámetros esperados a la función de Postgres", async () => {
  const supabase = client();
  supabase.rpcHandlers["registrar_intento"] = () => ({ data: true, error: null });

  await registrarIntento(supabase, "login:ip:1.2.3.4", 5, 60);

  assertEquals(supabase.rpcLlamadas.length, 1);
  assertEquals(supabase.rpcLlamadas[0].nombre, "registrar_intento");
  assertEquals(supabase.rpcLlamadas[0].args, {
    p_clave: "login:ip:1.2.3.4",
    p_max_intentos: 5,
    p_ventana_segundos: 60,
  });
});

Deno.test("registrarIntento: false de la BD significa bloqueado", async () => {
  const supabase = client();
  supabase.rpcHandlers["registrar_intento"] = () => ({ data: false, error: null });
  assertEquals(await registrarIntento(supabase, "k", 5, 60), false);
});

Deno.test("registrarIntento: ante un error de BD permite el intento", async () => {
  // Decisión consciente: si Postgres no responde, no convertir una caída de
  // la base en un bloqueo total de autenticación para todos los usuarios.
  const supabase = client();
  supabase.rpcHandlers["registrar_intento"] = () => ({
    data: null, error: { message: "conexión perdida" },
  });
  assertEquals(await registrarIntento(supabase, "k", 5, 60), true);
});

// ---- permitirIntentoDeLogin --------------------------------------------------

Deno.test("permitirIntentoDeLogin: limita por IP y por email (dos claves)", async () => {
  const supabase = client();
  supabase.rpcHandlers["registrar_intento"] = () => ({ data: true, error: null });

  assert(await permitirIntentoDeLogin(supabase, "1.2.3.4", "ana@example.com"));

  const claves = supabase.rpcLlamadas.map((l: { args: { p_clave: string } }) => l.args.p_clave);
  assertEquals(claves.sort(), ["login:email:ana@example.com", "login:ip:1.2.3.4"]);
});

Deno.test("permitirIntentoDeLogin: bloquea si la IP excedió, aunque el email no", async () => {
  const supabase = client();
  supabase.rpcHandlers["registrar_intento"] = (args: { p_clave: string }) => ({
    data: !args.p_clave.startsWith("login:ip:"), error: null,
  });
  assertEquals(await permitirIntentoDeLogin(supabase, "1.2.3.4", "ana@example.com"), false);
});

Deno.test("permitirIntentoDeLogin: bloquea si el email excedió, aunque la IP no", async () => {
  // Este es el caso que slowapi NO cubre: ataque distribuido desde muchas
  // IPs contra una sola cuenta. Es la razón de limitar también por email.
  const supabase = client();
  supabase.rpcHandlers["registrar_intento"] = (args: { p_clave: string }) => ({
    data: !args.p_clave.startsWith("login:email:"), error: null,
  });
  assertEquals(await permitirIntentoDeLogin(supabase, "1.2.3.4", "ana@example.com"), false);
});

Deno.test("permitirIntentoDeLogin: registra AMBAS claves aunque una ya bloquee", async () => {
  // Si al bloquear por IP no se registrara el intento contra el email, un
  // atacante rotando IPs nunca acumularía intentos contra la cuenta objetivo.
  const supabase = client();
  supabase.rpcHandlers["registrar_intento"] = (args: { p_clave: string }) => ({
    data: !args.p_clave.startsWith("login:ip:"), error: null,
  });

  await permitirIntentoDeLogin(supabase, "1.2.3.4", "ana@example.com");
  assertEquals(supabase.rpcLlamadas.length, 2);
});
