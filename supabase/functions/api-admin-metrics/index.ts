// Fase M23 — GET /api-admin-metrics. Back-office: números agregados del sistema.
//
// Endpoint deliberadamente mínimo: todo el trabajo de agregación vive en
// `facturapp.admin_metricas()` (migración 0013), que devuelve el JSON completo
// en una sola consulta. Aquí solo se comprueba el rol y se reenvía.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentAdmin } from "../_shared/auth.ts";
import { obtenerMetricas } from "../_shared/admin.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const admin = await getCurrentAdmin(req.headers.get("authorization"), supabase, secretKey);
  if (!admin) {
    return new Response(JSON.stringify({ detail: "No autorizado" }), {
      status: 403,
      headers: jsonHeaders,
    });
  }

  if (req.method !== "GET") {
    return new Response("Método no soportado", { status: 405, headers: corsHeaders });
  }

  return new Response(JSON.stringify(await obtenerMetricas(supabase)), {
    status: 200,
    headers: jsonHeaders,
  });
});
