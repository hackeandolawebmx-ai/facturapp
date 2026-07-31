// Fase M14 — GET/POST/DELETE /api/user/rfcs. Los RFCs de la cuenta.
//
// Una persona física tiene un solo RFC, así que varios en una cuenta siempre
// significan administrar a más de un contribuyente — típicamente una persona
// y su empresa.
//
// El `tipo` decide el tratamiento de sus facturas, no es un dato decorativo:
// las de una persona moral se archivan sin clasificar ni evaluar
// deducibilidad, porque el motor de este sistema implementa deducciones
// personales y aplicarlo a una empresa produciría juicios falsos. Ver
// 0008_multiples_rfcs.sql.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { validateRfc } from "../_shared/rfc_validation.ts";
import { agregarRfc, eliminarRfc, listarRfcs, type TipoContribuyente } from "../_shared/rfcs.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";
  const authUser = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!authUser) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  if (req.method === "GET") {
    return jsonResponse({ rfcs: await listarRfcs(supabase, authUser.id) }, 200);
  }

  if (req.method === "POST") {
    let payload: { rfc?: string; tipo?: string; alias?: string };
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ detail: "JSON inválido" }, 400);
    }

    if (payload.tipo !== "fisica" && payload.tipo !== "moral") {
      // Se exige explícito y no se adivina: de este valor depende si a las
      // facturas se les aplican reglas de deducción personal, y equivocarse
      // produce consejo fiscal falso.
      return jsonResponse(
        { detail: "Indica si el RFC es de persona 'fisica' o 'moral'" },
        422,
      );
    }
    // El tipo decide el formato esperado: 13 caracteres para persona física,
    // 12 para persona moral (sin la inicial del apellido materno). Validar
    // antes de saber el tipo habría rechazado cualquier RFC de empresa real.
    const rfc = validateRfc(payload.rfc ?? "", payload.tipo);
    if (!rfc) {
      const formato = payload.tipo === "moral" ? "AAA000000XXX (12 caracteres)" : "AAAA000000XXX (13 caracteres)";
      return jsonResponse(
        { detail: `RFC de persona ${payload.tipo} inválido. Formato esperado: ${formato}` },
        422,
      );
    }

    const alias = (payload.alias ?? "").trim() || null;
    const creado = await agregarRfc(
      supabase, authUser.id, rfc, payload.tipo as TipoContribuyente, alias,
    );
    if (!creado) {
      return jsonResponse({ detail: "Ese RFC ya está dado de alta en tu cuenta" }, 409);
    }
    return jsonResponse(creado, 201);
  }

  if (req.method === "DELETE") {
    const id = Number.parseInt(new URL(req.url).searchParams.get("id") ?? "", 10);
    if (Number.isNaN(id)) {
      return jsonResponse({ detail: "Falta el id del RFC" }, 422);
    }

    const resultado = await eliminarRfc(supabase, authUser.id, id);
    if (resultado.ok) {
      // Las facturas archivadas no se tocan: son comprobantes fiscales, y
      // quitar un RFC de la interfaz no debe destruir documentos.
      return jsonResponse({ message: "RFC eliminado. Sus facturas se conservan." }, 200);
    }
    if (resultado.motivo === "es_principal") {
      return jsonResponse(
        { detail: "No puedes eliminar tu RFC principal. Designa otro primero." },
        409,
      );
    }
    return jsonResponse({ detail: "RFC no encontrado" }, 404);
  }

  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
