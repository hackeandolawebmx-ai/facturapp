// Fase M7 — GET /api/summary. Port 1:1 de get_summary()/_summary_for_user() en main.py.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { summaryForUser } from "../_shared/invoices_api.ts";
import { anioFiscalActual } from "../_shared/fecha_mexico.ts";

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

  const url = new URL(req.url);
  const yearParam = url.searchParams.get("year");
  const year = yearParam ? parseInt(yearParam, 10) : anioFiscalActual();

  // Con varios RFCs en la cuenta, sin este filtro el total sumaría las
  // deducciones de contribuyentes distintos (Fase M14).
  const rfc = url.searchParams.get("rfc") ?? undefined;
  const result = await summaryForUser(supabase, authUser.id, year, rfc);
  return jsonResponse(result, 200);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "GET") return handleGet(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
