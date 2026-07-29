/**
 * Autenticación JWT (Fase M5.5) — port de facturapp/facturapp/auth.py.
 *
 * ⚠️ CORRECCIÓN respecto al spec original de esta fase: el spec proponía
 * validar el Bearer token contra la columna `facturapp.users.web_token` —
 * ESO ES INCORRECTO. `web_token` es un identificador para el dashboard
 * público sin autenticar (`/a/{token}`), no el mecanismo de auth real. El
 * sistema real usa JWT firmado (HS256, claim `"type": "access"`, `sub` =
 * user_id, `rfc`), igual que `/auth/login` y el resto de endpoints
 * autenticados de Python. Seguir el spec tal cual habría permitido que
 * cualquiera con el link público del dashboard de un usuario usara su chat
 * — un hueco de seguridad real, no un detalle de estilo.
 *
 * Verificado interoperable de verdad: un JWT emitido por
 * `create_access_token()` en Python (mismo SECRET_KEY) se verificó
 * correctamente aquí con la librería `jose` — no es una suposición.
 */
import { jwtVerify, SignJWT } from "jose";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuthenticatedUser {
  id: number;
  rfc: string;
}

// Mismos defaults que Settings en config.py (Python).
const ACCESS_TOKEN_EXPIRE_MINUTES = 60;
const REFRESH_TOKEN_EXPIRE_DAYS = 7;

/** Genera un `web_token` — identificador para el dashboard público
 * (`/a/{token}`, `/api/public/*`), NO un mecanismo de autenticación real
 * (ver nota de seguridad arriba). Equivalente a `secrets.token_urlsafe(24)`
 * en Python: 24 bytes de entropía, codificados base64url. */
export function generateWebToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Port 1:1 de create_access_token()/create_refresh_token() en auth.py. */
async function signToken(
  claims: { sub: string; rfc: string },
  type: "access" | "refresh",
  expiresIn: string,
  secretKey: string,
): Promise<string> {
  const secret = new TextEncoder().encode(secretKey);
  return await new SignJWT({ ...claims, type })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime(expiresIn)
    .sign(secret);
}

export function createAccessToken(userId: number, rfc: string, secretKey: string): Promise<string> {
  return signToken({ sub: String(userId), rfc }, "access", `${ACCESS_TOKEN_EXPIRE_MINUTES}m`, secretKey);
}

export function createRefreshToken(userId: number, rfc: string, secretKey: string): Promise<string> {
  return signToken({ sub: String(userId), rfc }, "refresh", `${REFRESH_TOKEN_EXPIRE_DAYS}d`, secretKey);
}

async function verifyTokenType(
  token: string,
  expectedType: "access" | "refresh",
  secretKey: string,
): Promise<{ userId: number; rfc: string } | null> {
  try {
    const secret = new TextEncoder().encode(secretKey);
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });

    if (payload.type !== expectedType) return null;

    const sub = payload.sub;
    const rfc = payload.rfc;
    if (typeof sub !== "string" || typeof rfc !== "string") return null;

    const userId = parseInt(sub, 10);
    if (Number.isNaN(userId)) return null;

    return { userId, rfc };
  } catch {
    return null;
  }
}

/** Verifica un access token JWT. Devuelve null si es inválido, expiró, o es
 * un refresh token (mismo chequeo de `"type"` que `verify_token()` en
 * Python) — nunca lanza. */
export function verifyAccessToken(
  token: string,
  secretKey: string,
): Promise<{ userId: number; rfc: string } | null> {
  return verifyTokenType(token, "access", secretKey);
}

/** Verifica un refresh token JWT — mismo chequeo que `verify_refresh_token()`
 * en Python. Devuelve null si es inválido, expiró, o es un access token. */
export function verifyRefreshToken(
  token: string,
  secretKey: string,
): Promise<{ userId: number; rfc: string } | null> {
  return verifyTokenType(token, "refresh", secretKey);
}

/** Extrae el Bearer token del header Authorization, lo verifica, y
 * confirma que el usuario sigue existiendo en BD — mismo flujo que
 * `get_current_user()` en Python (dependencia de FastAPI). El `rfc`
 * devuelto viene de la BD (fuente canónica), no del claim del token. */
export async function getCurrentUser(
  authHeader: string | null,
  supabase: SupabaseClient,
  secretKey: string,
): Promise<AuthenticatedUser | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length);
  const tokenData = await verifyAccessToken(token, secretKey);
  if (!tokenData) return null;

  const { data: user, error } = await supabase
    .schema("facturapp")
    .from("users")
    .select("id, rfc")
    .eq("id", tokenData.userId)
    .maybeSingle();

  if (error || !user) return null;
  return user as AuthenticatedUser;
}
