/**
 * Tests de autenticación JWT (Fase M5.5).
 *
 * Los tokens se generan aquí mismo con `jose` (mismo algoritmo/claims que
 * Python) — no se incrusta un JWT fijo generado por Python porque
 * expiraría y rompería el test permanentemente. La interoperabilidad real
 * (un JWT emitido por `create_access_token()` en Python, verificado aquí
 * con `jose`) se comprobó manualmente antes de escribir este código — ver
 * el README de la migración.
 */
import { SignJWT } from "jsr:@panva/jose@6";
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  createAccessToken, createRefreshToken, generateWebToken, getCurrentUser,
  verifyAccessToken, verifyRefreshToken,
} from "./auth.ts";
import { FakeSupabaseClient } from "./fake_supabase_client.ts";

const SECRET = "test-secret-suficientemente-largo-para-hs256";
const secretBytes = new TextEncoder().encode(SECRET);

async function signToken(
  claims: Record<string, unknown>, expiresIn: string = "1h",
): Promise<string> {
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expiresIn)
    .sign(secretBytes);
}

// ---- verifyAccessToken -------------------------------------------------------

Deno.test("verifyAccessToken: token de acceso válido", async () => {
  const token = await signToken({ sub: "42", rfc: "DAXX860715XX0", type: "access" });
  const data = await verifyAccessToken(token, SECRET);
  assertEquals(data, { userId: 42, rfc: "DAXX860715XX0" });
});

Deno.test("verifyAccessToken: un refresh token es rechazado (type incorrecto)", async () => {
  const token = await signToken({ sub: "42", rfc: "DAXX860715XX0", type: "refresh" });
  assertEquals(await verifyAccessToken(token, SECRET), null);
});

Deno.test("verifyAccessToken: token expirado es rechazado", async () => {
  const token = await signToken({ sub: "42", rfc: "DAXX860715XX0", type: "access" }, "-1h");
  assertEquals(await verifyAccessToken(token, SECRET), null);
});

Deno.test("verifyAccessToken: secreto incorrecto es rechazado", async () => {
  const token = await signToken({ sub: "42", rfc: "DAXX860715XX0", type: "access" });
  assertEquals(await verifyAccessToken(token, "otro-secreto-completamente-distinto"), null);
});

Deno.test("verifyAccessToken: token sin claim 'type' es rechazado", async () => {
  const token = await signToken({ sub: "42", rfc: "DAXX860715XX0" });
  assertEquals(await verifyAccessToken(token, SECRET), null);
});

Deno.test("verifyAccessToken: string que no es un JWT es rechazado", async () => {
  assertEquals(await verifyAccessToken("no-es-un-jwt", SECRET), null);
});

// ---- getCurrentUser (con FakeSupabaseClient) --------------------------------

Deno.test("getCurrentUser: token válido + usuario existente → autenticado", async () => {
  const supabase = new FakeSupabaseClient();
  supabase.tables.users.push({ id: 42, rfc: "DAXX860715XX0" });
  const token = await signToken({ sub: "42", rfc: "DAXX860715XX0", type: "access" });

  // deno-lint-ignore no-explicit-any
  const user = await getCurrentUser(`Bearer ${token}`, supabase as any, SECRET);
  assertEquals(user, { id: 42, rfc: "DAXX860715XX0" });
});

Deno.test("getCurrentUser: usuario del token ya no existe en BD → null", async () => {
  const supabase = new FakeSupabaseClient(); // sin usuarios
  const token = await signToken({ sub: "999", rfc: "DAXX860715XX0", type: "access" });

  // deno-lint-ignore no-explicit-any
  assertEquals(await getCurrentUser(`Bearer ${token}`, supabase as any, SECRET), null);
});

Deno.test("getCurrentUser: sin header Authorization → null", async () => {
  const supabase = new FakeSupabaseClient();
  // deno-lint-ignore no-explicit-any
  assertEquals(await getCurrentUser(null, supabase as any, SECRET), null);
});

Deno.test("getCurrentUser: header sin 'Bearer ' → null", async () => {
  const supabase = new FakeSupabaseClient();
  const token = await signToken({ sub: "42", rfc: "DAXX860715XX0", type: "access" });
  // deno-lint-ignore no-explicit-any
  assertEquals(await getCurrentUser(token, supabase as any, SECRET), null); // falta "Bearer "
});

Deno.test("getCurrentUser: un web_token NO sirve como access token (no es JWT)", async () => {
  // Un web_token real (generate_web_token() en Python) es un string
  // aleatorio de secrets.token_urlsafe(), NO un JWT — debe fallar la
  // verificación por completo, no "colarse" por otro camino.
  const supabase = new FakeSupabaseClient();
  supabase.tables.users.push({ id: 1, rfc: "DAXX860715XX0" });
  // deno-lint-ignore no-explicit-any
  const result = await getCurrentUser("Bearer RT9EniZWBD7eu3OemqdxLbEb85VvH-Ee", supabase as any, SECRET);
  assertEquals(result, null);
});

// ---- createAccessToken / createRefreshToken / verifyRefreshToken (Fase M7) --

Deno.test("createAccessToken: produce un token que verifyAccessToken acepta", async () => {
  const token = await createAccessToken(42, "DAXX860715XX0", SECRET);
  const data = await verifyAccessToken(token, SECRET);
  assertEquals(data, { userId: 42, rfc: "DAXX860715XX0" });
});

Deno.test("createRefreshToken: produce un token que verifyRefreshToken acepta", async () => {
  const token = await createRefreshToken(42, "DAXX860715XX0", SECRET);
  const data = await verifyRefreshToken(token, SECRET);
  assertEquals(data, { userId: 42, rfc: "DAXX860715XX0" });
});

Deno.test("verifyRefreshToken: rechaza un access token (type incorrecto)", async () => {
  const token = await createAccessToken(42, "DAXX860715XX0", SECRET);
  assertEquals(await verifyRefreshToken(token, SECRET), null);
});

Deno.test("verifyAccessToken: rechaza un refresh token creado por createRefreshToken", async () => {
  const token = await createRefreshToken(42, "DAXX860715XX0", SECRET);
  assertEquals(await verifyAccessToken(token, SECRET), null);
});

Deno.test("generateWebToken: produce strings distintos y razonablemente largos", () => {
  const a = generateWebToken();
  const b = generateWebToken();
  assertNotEquals(a, b);
  assert(a.length >= 24);
});
