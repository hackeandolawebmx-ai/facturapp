// Fase M7 — GET /api/public/invoices?token=... Port 1:1 de public_invoices() en main.py.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getUserByWebToken } from "../_shared/users.ts";
import { listInvoicesForUser } from "../_shared/invoices_api.ts";
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
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  if (!token) return jsonResponse({ detail: "token es obligatorio" }, 422);

  const supabase = getSupabaseClient();
  const user = await getUserByWebToken(supabase, token);
  if (!user) return jsonResponse({ detail: "Token inválido" }, 404);

  const yearParam = url.searchParams.get("year");
  const year = yearParam ? parseInt(yearParam, 10) : anioFiscalActual();

  const result = await listInvoicesForUser(supabase, user.id, year);
  return jsonResponse(result, 200);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "GET") return handleGet(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
