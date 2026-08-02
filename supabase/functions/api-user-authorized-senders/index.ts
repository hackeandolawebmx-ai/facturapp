// Fase M18 — GET/POST/DELETE /api/user/authorized-senders.
//
// Correos autorizados a alimentar la cuenta por email: sin esto, reenviar
// una factura desde una dirección distinta a la registrada crea o usa una
// cuenta DIFERENTE en silencio (ver authorized_senders.ts / users.ts
// getOrCreateUserByEmail). Mismo patrón que api-user-rfcs.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import {
  agregarCorreoAutorizado, eliminarCorreoAutorizado, listarCorreosAutorizados,
} from "../_shared/authorized_senders.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";
  const authUser = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!authUser) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  if (req.method === "GET") {
    return jsonResponse(
      { correos: await listarCorreosAutorizados(supabase, authUser.id) }, 200,
    );
  }

  if (req.method === "POST") {
    let payload: { email?: string; alias?: string };
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ detail: "JSON inválido" }, 400);
    }

    const email = (payload.email ?? "").trim();
    if (!EMAIL_RE.test(email)) {
      return jsonResponse({ detail: "Correo inválido" }, 422);
    }

    const alias = (payload.alias ?? "").trim() || null;
    const resultado = await agregarCorreoAutorizado(supabase, authUser.id, email, alias);
    if (!resultado.ok) {
      return jsonResponse(
        { detail: "Ese correo ya está registrado o autorizado en otra cuenta" }, 409,
      );
    }
    return jsonResponse(resultado.correo, 201);
  }

  if (req.method === "DELETE") {
    const id = Number.parseInt(new URL(req.url).searchParams.get("id") ?? "", 10);
    if (Number.isNaN(id)) {
      return jsonResponse({ detail: "Falta el id del correo" }, 422);
    }

    const eliminado = await eliminarCorreoAutorizado(supabase, authUser.id, id);
    if (!eliminado) {
      return jsonResponse({ detail: "Correo autorizado no encontrado" }, 404);
    }
    return jsonResponse({ message: "Correo autorizado eliminado" }, 200);
  }

  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
