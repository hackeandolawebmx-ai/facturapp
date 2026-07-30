// Fase M7 — POST /auth/login. Port de login() en main.py.
//
// El rate limiting (Fase M8) NO es un port: Python usa slowapi, un contador
// en memoria del proceso, inútil en Edge Functions porque cada invocación
// puede caer en una instancia distinta. Se conserva el mismo límite
// efectivo (5/minuto) con el estado en Postgres -- ver rate_limit.ts y
// 0006_rate_limit.sql.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { createAccessToken, createRefreshToken } from "../_shared/auth.ts";
import { verifyPassword } from "../_shared/passwords.ts";
import {
  ipDelCliente, LOGIN_VENTANA_SEGUNDOS, permitirIntentoDeLogin,
} from "../_shared/rate_limit.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

const ACCESS_TOKEN_EXPIRE_SECONDS = 60 * 60; // 1h, mismo default que config.py

async function handlePost(req: Request): Promise<Response> {
  let payload: { email?: string; password?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ detail: "JSON inválido" }, 400);
  }

  const email = (payload.email ?? "").trim().toLowerCase();
  const password = payload.password ?? "";
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const supabase = getSupabaseClient();

  // Antes de tocar la contraseña: si ya se excedió el límite, se corta aquí
  // sin ejecutar bcrypt (que es caro a propósito) ni consultar el usuario.
  const ip = ipDelCliente(req.headers);
  if (!await permitirIntentoDeLogin(supabase, ip, email)) {
    console.warn(`Rate limit de login excedido (ip=${ip}, email=${email})`);
    return new Response(
      JSON.stringify({ detail: "Demasiados intentos. Espera un momento e inténtalo de nuevo." }),
      {
        status: 429,
        // Retry-After es estándar en 429 y le dice al cliente cuánto esperar
        // en vez de dejarlo reintentar a ciegas.
        headers: { ...jsonHeaders, "Retry-After": String(LOGIN_VENTANA_SEGUNDOS) },
      },
    );
  }

  const { data: user, error } = await supabase
    .schema("facturapp").from("users")
    .select("id, rfc, hashed_password")
    .eq("email", email)
    .maybeSingle();

  if (error) return jsonResponse({ detail: "Error consultando usuario" }, 500);
  if (!user || !user.hashed_password || !verifyPassword(password, user.hashed_password)) {
    console.warn(`Login fallido para ${email}`);
    return jsonResponse({ detail: "Credenciales inválidas" }, 401);
  }

  const access = await createAccessToken(user.id, user.rfc, secretKey);
  const refresh = await createRefreshToken(user.id, user.rfc, secretKey);

  return jsonResponse({
    access_token: access,
    refresh_token: refresh,
    token_type: "bearer",
    expires_in: ACCESS_TOKEN_EXPIRE_SECONDS,
    user_id: user.id,
  }, 200);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "POST") return handlePost(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
