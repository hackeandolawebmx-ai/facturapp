/**
 * Rate limiting con estado en Postgres (Fase M8).
 *
 * NO es un port de security.py. Python usa slowapi, un contador en memoria
 * del proceso, que no limita nada en Edge Functions: cada invocación puede
 * caer en una instancia distinta. Se conserva el mismo límite efectivo que
 * el original (5 intentos por minuto por IP en /auth/login), pero el estado
 * vive en Postgres -- ver 0006_rate_limit.sql.
 *
 * DIVERGENCIA DELIBERADA respecto a Python: además de la IP, se limita por
 * email. slowapi solo usa `get_remote_address`, lo que deja abierto el
 * ataque distribuido -- muchas IPs probando contraseñas contra una misma
 * cuenta, que es justo el caso que importa proteger. Limitar por IP sola
 * habría sido fiel al original y a la vez inútil contra el ataque realista.
 */
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

/** Mismo límite efectivo que `@limiter.limit("5/minute")` en Python. */
export const LOGIN_MAX_INTENTOS = 5;
export const LOGIN_VENTANA_SEGUNDOS = 60;

/**
 * Extrae la IP del cliente de los headers del proxy.
 *
 * En Edge Functions no hay socket directo: la IP real llega en headers que
 * pone Cloudflare. `x-forwarded-for` puede traer una cadena de proxies; el
 * primer elemento es el cliente original.
 *
 * Devuelve "desconocida" si no hay ninguno, lo que agrupa a todos los
 * clientes sin IP identificable bajo una misma cubeta. Es el comportamiento
 * seguro: ante la duda, limitar de más y no de menos.
 */
export function ipDelCliente(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const primera = forwarded.split(",")[0].trim();
    if (primera) return primera;
  }
  return headers.get("cf-connecting-ip") ?? headers.get("x-real-ip") ?? "desconocida";
}

/** Registra un intento contra `clave` y dice si se permite.
 *
 * Ante un error de base de datos devuelve `true` (permite). Es una decisión
 * consciente: si Postgres no responde, el login ya va a fallar de todos
 * modos en la consulta del usuario, y prefiero no convertir una caída de la
 * base en un bloqueo total de autenticación para todos los usuarios. El
 * error queda en el log. */
export async function registrarIntento(
  supabase: SupabaseClient,
  clave: string,
  maxIntentos: number,
  ventanaSegundos: number,
): Promise<boolean> {
  const { data, error } = await supabase.schema("facturapp").rpc("registrar_intento", {
    p_clave: clave,
    p_max_intentos: maxIntentos,
    p_ventana_segundos: ventanaSegundos,
  });
  if (error) {
    console.error("Error consultando el rate limit (se permite el intento):", error);
    return true;
  }
  return data === true;
}

/** Aplica el límite de /auth/login por IP y por email.
 *
 * Devuelve `true` si el intento se permite. Se evalúan AMBAS claves y se
 * registran las dos aunque la primera ya haya bloqueado -- si solo se
 * evaluara la IP, un atacante distribuido nunca acumularía intentos contra
 * el email objetivo.
 */
export async function permitirIntentoDeLogin(
  supabase: SupabaseClient,
  ip: string,
  email: string,
): Promise<boolean> {
  const [porIp, porEmail] = await Promise.all([
    registrarIntento(supabase, `login:ip:${ip}`, LOGIN_MAX_INTENTOS, LOGIN_VENTANA_SEGUNDOS),
    registrarIntento(supabase, `login:email:${email}`, LOGIN_MAX_INTENTOS, LOGIN_VENTANA_SEGUNDOS),
  ]);
  return porIp && porEmail;
}
