// Fase M7 — POST /auth/login. Port de login() en main.py.
//
// DIVERGENCIA DECLARADA: Python aplica rate limiting (@limiter.limit("5/minute")
// vía slowapi, en memoria por proceso). Un límite en memoria no tiene
// sentido en Edge Functions (cada invocación puede caer en una instancia
// distinta, sin estado compartido) -- portarlo tal cual habría sido un
// límite falso que da falsa sensación de protección. Requiere una solución
// real (contador en Postgres, o el rate limiting de la capa de gateway de
// Supabase) -- fuera de alcance de este port; señalado explícitamente, no
// omitido en silencio.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { createAccessToken, createRefreshToken } from "../_shared/auth.ts";
import { verifyPassword } from "../_shared/passwords.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
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
