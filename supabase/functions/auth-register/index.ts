// Fase M7 — POST /auth/register. Port 1:1 de register() en main.py.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { generateWebToken } from "../_shared/auth.ts";
import { hashPassword } from "../_shared/passwords.ts";
import { validateRfc } from "../_shared/rfc_validation.ts";

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

interface RegisterPayload {
  email?: string;
  nombre?: string;
  rfc?: string;
  password?: string;
}

async function handlePost(req: Request): Promise<Response> {
  console.log("handlePost: inicio");
  try {
    console.log("handlePost: antes de parsear JSON");
    let payload: RegisterPayload;
    try {
      payload = await req.json();
    } catch (e) {
      console.error("Error parseando JSON:", e);
      return jsonResponse({ detail: "JSON inválido" }, 400);
    }

    console.log("handlePost: JSON parseado, email:", payload.email);
    const email = (payload.email ?? "").trim().toLowerCase();
    const nombre = (payload.nombre ?? "").trim();
    const password = payload.password ?? "";

    console.log("handlePost: antes de validación de email");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse({ detail: "Email inválido" }, 422);
    }
    if (nombre.length < 1 || nombre.length > 255) {
      return jsonResponse({ detail: "Nombre debe tener entre 1 y 255 caracteres" }, 422);
    }
    if (password.length < 8 || password.length > 128) {
      return jsonResponse({ detail: "Password debe tener entre 8 y 128 caracteres" }, 422);
    }
    const rfc = validateRfc(payload.rfc ?? "");
    if (!rfc) {
      return jsonResponse(
        { detail: "RFC debe tener 13 caracteres alfanuméricos (formato: AAAA000000XXX)" },
        422,
      );
    }

    console.log("handlePost: antes de getSupabaseClient");
    const supabase = getSupabaseClient();
    console.log("handlePost: después de getSupabaseClient");

    const { data: existing, error: selectError } = await supabase
      .schema("facturapp").from("users")
      .select("id, email, rfc")
      .eq("email", email)
      .maybeSingle();
    if (selectError) return jsonResponse({ detail: "Error consultando usuario" }, 500);
    if (existing) {
      return jsonResponse({ detail: "Ese email ya está registrado" }, 400);
    }
    const { data: existingRfc, error: selectRfcError } = await supabase
      .schema("facturapp").from("users")
      .select("id")
      .eq("rfc", rfc)
      .maybeSingle();
    if (selectRfcError) return jsonResponse({ detail: "Error consultando usuario" }, 500);
    if (existingRfc) {
      return jsonResponse({ detail: "Ese RFC ya está registrado" }, 400);
    }

    console.log("handlePost: antes de hashPassword");
    const hashedPw = hashPassword(password);
    console.log("handlePost: después de hashPassword");
    const webToken = generateWebToken();
    console.log("handlePost: antes de insert");

    const { data: created, error: insertError } = await supabase
      .schema("facturapp").from("users")
      .insert({
        email, nombre, rfc,
        hashed_password: hashedPw,
        web_token: webToken,
      })
      .select("id")
      .single();
    if (insertError || !created) {
      console.error("Insert error:", insertError);
      return jsonResponse({ detail: "Error registrando usuario" }, 500);
    }

    console.log("handlePost: éxito");
    return jsonResponse({ user_id: created.id, message: "Registrado exitosamente" }, 201);
  } catch (err) {
    console.error("Error en handlePost:", err);
    return jsonResponse({ detail: `Error interno: ${err instanceof Error ? err.message : String(err)}` }, 500);
  }
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "POST") return handlePost(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
