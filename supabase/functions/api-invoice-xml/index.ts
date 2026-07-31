// Fase M13 — GET /api/invoices/{id}/xml. Descarga el XML original.
//
// No existe en Python. El XML se venía guardando en `raw_xml` desde M4, pero
// ningún endpoint lo devolvía: el comprobante fiscal estaba archivado y a la
// vez era irrecuperable. Para una app de deducciones eso vacía buena parte de
// su propósito — el XML ES la factura ante el SAT; el PDF solo la representa.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { getInvoiceXml } from "../_shared/invoices_api.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

/** Acepta el id por query (`?id=123`) o como sufijo de la ruta
 * (`.../api-invoice-xml/123`), que es como lo enrutaría un `/{id}/xml`. */
function extraerId(url: URL): number | null {
  const porQuery = url.searchParams.get("id");
  const crudo = porQuery ?? url.pathname.match(/\/(\d+)\/?$/)?.[1];
  if (!crudo) return null;
  const id = Number.parseInt(crudo, 10);
  return Number.isNaN(id) ? null : id;
}

async function handleGet(req: Request): Promise<Response> {
  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";

  const authUser = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!authUser) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  const id = extraerId(new URL(req.url));
  if (id === null) {
    return jsonResponse({ detail: "Falta el id de la factura" }, 422);
  }

  const factura = await getInvoiceXml(supabase, authUser.id, id);
  if (!factura) {
    // Mismo 404 para "no existe", "es de otro" y "no tiene XML": distinguirlos
    // le diría a un tercero qué ids existen en la base.
    return jsonResponse({ detail: "Factura no encontrada" }, 404);
  }

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "application/xml; charset=utf-8");
  // Con `attachment` el navegador descarga en vez de intentar mostrarlo, y el
  // archivo queda nombrado con el UUID fiscal — que es como el SAT y los
  // contadores identifican una factura.
  headers.set("Content-Disposition", `attachment; filename="${factura.uuid}.xml"`);
  headers.set("Cache-Control", "no-store");

  return new Response(factura.xml, { status: 200, headers });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "GET") return handleGet(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
