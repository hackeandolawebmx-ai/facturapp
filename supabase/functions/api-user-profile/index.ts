// Fase M7 — GET /api/user/profile. Port 1:1 de profile() en main.py.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { getUserProfile } from "../_shared/users.ts";
import { capturarRfc } from "../_shared/onboarding.ts";

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

async function handleGet(req: Request): Promise<Response> {
  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const authUser = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!authUser) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  const profile = await getUserProfile(supabase, authUser.id);
  if (!profile) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }
  return jsonResponse(profile, 200);
}

/** PATCH /api/user/profile — por ahora solo el RFC (Fase M11).
 *
 * Es el único camino existente para que una cuenta creada por WhatsApp o
 * correo deje atrás su RFC sintético `PEND...`. Sin esto, todas sus facturas
 * salen marcadas como no deducibles. Ver updateUserRfc() en users.ts.
 */
async function handlePatch(req: Request): Promise<Response> {
  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const authUser = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!authUser) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  let payload: { rfc?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ detail: "JSON inválido" }, 400);
  }

  // Fase M24: los cuatro pasos (validar, comprobar que no esté tomado,
  // guardar, y revalidar las facturas ya archivadas) viven en capturarRfc,
  // compartidos con el bot de WhatsApp. Antes estaban escritos aquí; al
  // agregar el segundo canal, duplicarlos habría bastado con que uno olvidara
  // la revalidación para dejar a ese usuario con advertencias falsas
  // permanentes -- ver revalidarRfcAjeno() en validator.ts.
  const resultado = await capturarRfc(supabase, authUser.id, payload.rfc ?? "");

  if (!resultado.ok) {
    if (resultado.motivo === "tomado") {
      return jsonResponse({ detail: "Ese RFC ya está registrado en otra cuenta" }, 409);
    }
    if (resultado.motivo === "error") {
      return jsonResponse({ detail: "No se pudo actualizar el perfil" }, 500);
    }
    return jsonResponse(
      { detail: "RFC debe tener 13 caracteres alfanuméricos (formato: AAAA000000XXX)" },
      422,
    );
  }

  const perfil = await getUserProfile(supabase, authUser.id);
  return jsonResponse(
    { ...perfil, facturas_revalidadas: resultado.facturasActualizadas },
    200,
  );
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "GET") return handleGet(req);
  if (req.method === "PATCH") return handlePatch(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
