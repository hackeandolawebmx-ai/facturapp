// Fase M23 — GET/PATCH /api-admin-users. Back-office: cuentas del sistema.
//
// Es el único endpoint que devuelve datos de cuentas ajenas, así que el guard
// de rol va literalmente antes que cualquier otra cosa: no se parsea el
// cuerpo, no se lee un query param, no se toca la base. Si `getCurrentAdmin`
// no devuelve un admin, la petición muere ahí.
//
// GET                → listado (?q=, ?estado=, ?limit=, ?offset=)
// GET ?id=N          → detalle de una cuenta, para dar soporte
// PATCH ?id=N        → {accion: "suspender"|"reactivar", motivo?}
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentAdmin } from "../_shared/auth.ts";
import {
  cambiarEstadoCuenta, facturasRecientes, listarCuentas, obtenerCuenta,
} from "../_shared/admin.ts";
import { listarRfcs } from "../_shared/rfcs.ts";
import { listarCorreosAutorizados } from "../_shared/authorized_senders.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

/** `?id=` como entero, o `null` si no viene o no es un número. */
function idDeLaUrl(url: URL): number | null {
  const crudo = url.searchParams.get("id");
  if (crudo === null) return null;
  const id = Number.parseInt(crudo, 10);
  return Number.isNaN(id) ? null : id;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const admin = await getCurrentAdmin(req.headers.get("authorization"), supabase, secretKey);
  if (!admin) {
    // Mismo 403 tanto si no hay sesión como si la hay sin permisos: un usuario
    // normal no debe poder deducir que este endpoint existe.
    return jsonResponse({ detail: "No autorizado" }, 403);
  }

  const url = new URL(req.url);
  const id = idDeLaUrl(url);

  if (req.method === "GET" && id === null) {
    const { cuentas, total } = await listarCuentas(supabase, {
      q: url.searchParams.get("q") ?? undefined,
      estado: url.searchParams.get("estado") ?? undefined,
      limit: Number.parseInt(url.searchParams.get("limit") ?? "", 10) || undefined,
      offset: Number.parseInt(url.searchParams.get("offset") ?? "", 10) || undefined,
    });
    return jsonResponse({ cuentas, total }, 200);
  }

  if (req.method === "GET") {
    const cuenta = await obtenerCuenta(supabase, id!);
    if (!cuenta) return jsonResponse({ detail: "Cuenta no encontrada" }, 404);

    // Las cuatro cosas que hacen falta para diagnosticar un "no me llegó la
    // factura": quién es, qué RFCs tiene dados de alta, desde qué correos
    // puede mandar, y qué entró realmente. Se piden en paralelo porque son
    // independientes entre sí.
    const [rfcs, correos, facturas] = await Promise.all([
      listarRfcs(supabase, id!),
      listarCorreosAutorizados(supabase, id!),
      facturasRecientes(supabase, id!),
    ]);
    return jsonResponse({ cuenta, rfcs, correos, facturas }, 200);
  }

  if (req.method === "PATCH") {
    if (id === null) return jsonResponse({ detail: "Falta el id de la cuenta" }, 422);

    let payload: { accion?: string; motivo?: string };
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ detail: "JSON inválido" }, 400);
    }

    if (payload.accion !== "suspender" && payload.accion !== "reactivar") {
      return jsonResponse({ detail: "accion debe ser 'suspender' o 'reactivar'" }, 422);
    }

    const motivo = (payload.motivo ?? "").trim() || null;
    const resultado = await cambiarEstadoCuenta(
      supabase, admin.id, id, payload.accion, motivo,
    );

    if (resultado.ok) {
      return jsonResponse({
        id,
        suspendida: resultado.suspendida,
        message: resultado.suspendida ? "Cuenta suspendida." : "Cuenta reactivada.",
      }, 200);
    }
    if (resultado.motivo === "no_encontrada") {
      return jsonResponse({ detail: "Cuenta no encontrada" }, 404);
    }
    if (resultado.motivo === "es_uno_mismo") {
      return jsonResponse(
        { detail: "No puedes suspender tu propia cuenta: perderías el acceso al panel." },
        409,
      );
    }
    return jsonResponse(
      { detail: "No puedes suspender a otro administrador. Quítale el rol primero." },
      409,
    );
  }

  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
