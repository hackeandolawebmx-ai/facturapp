// Fase M7 — POST /auth/refresh. Port 1:1 de refresh_access_token() en main.py.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { createAccessToken, verifyRefreshToken } from "../_shared/auth.ts";

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

const ACCESS_TOKEN_EXPIRE_SECONDS = 60 * 60;

async function handlePost(req: Request): Promise<Response> {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ detail: "Falta el refresh token" }, 401);
  }
  const token = authHeader.slice("Bearer ".length);
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const tokenData = await verifyRefreshToken(token, secretKey);
  if (!tokenData) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  const supabase = getSupabaseClient();
  const { data: user, error } = await supabase
    .schema("facturapp").from("users")
    .select("id, rfc")
    .eq("id", tokenData.userId)
    .maybeSingle();

  if (error) return jsonResponse({ detail: "Error consultando usuario" }, 500);
  if (!user) return jsonResponse({ detail: "Usuario no encontrado" }, 401);

  const newAccess = await createAccessToken(user.id, user.rfc, secretKey);
  return jsonResponse({
    access_token: newAccess,
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
