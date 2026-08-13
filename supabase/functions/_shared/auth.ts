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
import { jwtVerify, SignJWT } from "jsr:@panva/jose@6";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

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

/** Fila de `users` que necesita la autenticación: identidad, rol y estado.
 * No se expone — `getCurrentUser` devuelve solo `{id, rfc}`, que es lo único
 * que consumen los endpoints. */
interface FilaAutenticacion {
  id: number;
  rfc: string;
  rol: string | null;
  suspendida_en: string | null;
}

/** Verifica el Bearer token y trae la fila del usuario, o `null`.
 *
 * Aquí es donde se corta el acceso de una cuenta SUSPENDIDA (Fase M23), y es
 * deliberado que sea aquí y no en cada endpoint: los ~12 endpoints
 * autenticados ya pasan todos por `getCurrentUser`, así que este único punto
 * los cubre a todos. Poner el chequeo endpoint por endpoint habría garantizado
 * que alguno se olvidara -- y "se me olvidó en uno" significa que la cuenta
 * suspendida sigue teniendo acceso justo por ahí.
 *
 * Una cuenta suspendida es indistinguible de un token inválido desde afuera
 * (ambos dan 401). El mensaje explícito de "tu cuenta está suspendida" se da
 * en el login, que es donde el usuario puede entenderlo y actuar.
 */
async function cargarUsuarioAutenticado(
  authHeader: string | null,
  supabase: SupabaseClient,
  secretKey: string,
): Promise<FilaAutenticacion | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const token = authHeader.slice("Bearer ".length);
  const tokenData = await verifyAccessToken(token, secretKey);
  if (!tokenData) return null;

  const { data: user, error } = await supabase
    .schema("facturapp")
    .from("users")
    .select("id, rfc, rol, suspendida_en")
    .eq("id", tokenData.userId)
    .maybeSingle();

  if (error || !user) return null;
  const fila = user as FilaAutenticacion;
  if (fila.suspendida_en) return null;
  return fila;
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
  const fila = await cargarUsuarioAutenticado(authHeader, supabase, secretKey);
  if (!fila) return null;
  // Solo id y rfc: el rol y el estado son asunto de la autenticación, no algo
  // que los endpoints de negocio deban ver ni poder confundir con datos suyos.
  return { id: fila.id, rfc: fila.rfc };
}

/** Igual que `getCurrentUser`, pero además exige rol de administrador
 * (Fase M23). Es el guard de los endpoints `api-admin-*`, que leen y modifican
 * datos de TODAS las cuentas.
 *
 * Devuelve `null` tanto si no hay sesión válida como si la hay pero sin
 * permisos: quien llama responde 403 en ambos casos, y así un usuario normal
 * no puede distinguir "este endpoint existe pero no eres admin" de "no
 * existe". */
export async function getCurrentAdmin(
  authHeader: string | null,
  supabase: SupabaseClient,
  secretKey: string,
): Promise<AuthenticatedUser | null> {
  const fila = await cargarUsuarioAutenticado(authHeader, supabase, secretKey);
  // `rol` puede venir nulo en filas anteriores a la migración 0013; cualquier
  // valor que no sea exactamente "admin" niega el acceso (falla cerrado).
  if (!fila || fila.rol !== "admin") return null;
  return { id: fila.id, rfc: fila.rfc };
}
