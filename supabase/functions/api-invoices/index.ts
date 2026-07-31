// Fase M7 — GET /api/invoices y POST /api/invoices/{id}/reclassify.
// Port 1:1 de list_invoices()/reclassify() en main.py.
//
// Una sola función porque comparten el mismo recurso ("invoices"),
// distinguidos por método + path: Supabase enruta todo lo que sigue al
// nombre de la función (/functions/v1/api-invoices/{id}/reclassify) al
// mismo handler; el sufijo se parsea aquí, igual que un router de FastAPI.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { listInvoicesForUser, reclassifyInvoiceById } from "../_shared/invoices_api.ts";

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

async function handleGet(req: Request, userId: number, supabase: unknown): Promise<Response> {
  const url = new URL(req.url);
  const yearParam = url.searchParams.get("year");
  const year = yearParam ? parseInt(yearParam, 10) : 2026;
  const rfc = url.searchParams.get("rfc") ?? undefined;
  // deno-lint-ignore no-explicit-any
  const result = await listInvoicesForUser(supabase as any, userId, year, rfc);
  return jsonResponse(result, 200);
}

/** Extrae el `{id}` de `/api-invoices/{id}/reclassify` -- lo que Supabase
 * enruta después del nombre de la función. */
function extractReclassifyId(pathname: string): number | null {
  const match = pathname.match(/\/([0-9]+)\/reclassify\/?$/);
  if (!match) return null;
  const id = parseInt(match[1], 10);
  return Number.isNaN(id) ? null : id;
}

async function handlePost(req: Request, userId: number, supabase: unknown): Promise<Response> {
  const url = new URL(req.url);
  const invoiceId = extractReclassifyId(url.pathname);
  if (invoiceId === null) {
    return jsonResponse({ detail: "Ruta no encontrada" }, 404);
  }

  const nuevaCategoria = url.searchParams.get("nueva_categoria");
  if (!nuevaCategoria) {
    return jsonResponse({ detail: "nueva_categoria es obligatorio" }, 422);
  }

  // deno-lint-ignore no-explicit-any
  const result = await reclassifyInvoiceById(supabase as any, userId, invoiceId, nuevaCategoria);
  if (!result) {
    return jsonResponse({ detail: "Factura no encontrada" }, 404);
  }
  return jsonResponse(result, 200);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";
  const authUser = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!authUser) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  if (req.method === "GET") return handleGet(req, authUser.id, supabase);
  if (req.method === "POST") return handlePost(req, authUser.id, supabase);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
