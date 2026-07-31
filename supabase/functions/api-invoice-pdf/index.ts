// Fase M13 — GET /api/invoices/{id}/pdf. Descarga el PDF de una factura.
//
// El PDF vive en un bucket PRIVADO de Storage, no accesible por URL directa:
// son datos fiscales personales. Se sirve a través de esta función, que
// primero valida el JWT y que la factura sea del usuario que la pide, y solo
// entonces lee el archivo con la service role.
//
// Se transmite el contenido en vez de devolver una URL firmada: una URL
// firmada es un enlace que funciona para cualquiera que lo tenga durante su
// vigencia, y no hay razón para crear ese objeto compartible cuando el
// navegador ya viene autenticado.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { getInvoicePdfPath } from "../_shared/invoices_api.ts";
import { descargarPdf } from "../_shared/pdf_storage.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

function extraerId(url: URL): number | null {
  const crudo = url.searchParams.get("id") ?? url.pathname.match(/\/(\d+)\/?$/)?.[1];
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

  const factura = await getInvoicePdfPath(supabase, authUser.id, id);
  if (!factura) {
    return jsonResponse({ detail: "Esa factura no tiene PDF guardado" }, 404);
  }

  const contenido = await descargarPdf(supabase, factura.pdfPath);
  if (!contenido) {
    // La fila apunta a un archivo que no está: inconsistencia real, no un
    // caso normal, así que se distingue del 404 anterior para poder notarla.
    console.error(`pdf_path apunta a un archivo inexistente: ${factura.pdfPath}`);
    return jsonResponse({ detail: "No se pudo recuperar el archivo" }, 500);
  }

  const headers = new Headers(corsHeaders);
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", `attachment; filename="${factura.uuid}.pdf"`);
  headers.set("Cache-Control", "no-store");

  return new Response(contenido, { status: 200, headers });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method === "GET") return handleGet(req);
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
