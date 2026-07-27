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
import { jwtVerify } from "jose";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface AuthenticatedUser {
  id: number;
  rfc: string;
}

/** Verifica un access token JWT. Devuelve null si es inválido, expiró, o es
 * un refresh token (mismo chequeo de `"type"` que `verify_token()` en
 * Python) — nunca lanza. */
export async function verifyAccessToken(
  token: string,
  secretKey: string,
): Promise<{ userId: number; rfc: string } | null> {
  try {
    const secret = new TextEncoder().encode(secretKey);
    const { payload } = await jwtVerify(token, secret, { algorithms: ["HS256"] });

    if (payload.type !== "access") return null;

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
