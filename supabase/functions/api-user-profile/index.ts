// Fase M7 — GET /api/user/profile. Port 1:1 de profile() en main.py.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import {
  getUserProfile, revalidarFacturasTrasCambioDeRfc, rfcTomadoPorOtro, updateUserRfc,
} from "../_shared/users.ts";
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

  const rfc = validateRfc(payload.rfc ?? "");
  if (!rfc) {
    return jsonResponse(
      { detail: "RFC debe tener 13 caracteres alfanuméricos (formato: AAAA000000XXX)" },
      422,
    );
  }

  if (await rfcTomadoPorOtro(supabase, authUser.id, rfc)) {
    return jsonResponse({ detail: "Ese RFC ya está registrado en otra cuenta" }, 409);
  }

  const perfil = await updateUserRfc(supabase, authUser.id, rfc);
  if (!perfil) {
    return jsonResponse({ detail: "No se pudo actualizar el perfil" }, 500);
  }

  // Las facturas ya archivadas se validaron contra el RFC anterior. Si no se
  // recalculan, quedan advertencias que se contradicen con el perfil en
  // pantalla: "Factura emitida a RFC X; no será deducible" junto a un RFC de
  // usuario que ES X. Ver revalidarRfcAjeno() en validator.ts.
  const revalidadas = await revalidarFacturasTrasCambioDeRfc(supabase, authUser.id, rfc);

  return jsonResponse({ ...perfil, facturas_revalidadas: revalidadas }, 200);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "GET") return handleGet(req);
  if (req.method === "PATCH") return handlePatch(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
