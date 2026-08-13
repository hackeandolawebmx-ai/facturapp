// Fase M19 — POST /api/invoice-upload: sube una factura desde el dashboard.
//
// El botón "Subir factura" ya se prometía en la página de Facturas ("¿Cómo
// enviar facturas?") pero nunca existió del lado del servidor -- este
// endpoint es lo que le falta. A diferencia de sendgrid-webhook (que resuelve
// el usuario por el correo remitente) y whatsapp-webhook (por el teléfono),
// aquí el usuario YA está autenticado con su propio Bearer token: no hay que
// resolver ninguna cuenta, la factura se atribuye directo a quien hizo login.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import { getCurrentUser } from "../_shared/auth.ts";
import { ingestInvoice } from "../_shared/invoices.ts";
import { subirPdf } from "../_shared/pdf_storage.ts";

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
  if (req.method !== "POST") {
    return new Response("Método no soportado", { status: 405, headers: corsHeaders });
  }

  const supabase = getSupabaseClient();
  const secretKey = Deno.env.get("SECRET_KEY") ?? "";
  const authUser = await getCurrentUser(req.headers.get("authorization"), supabase, secretKey);
  if (!authUser) {
    return jsonResponse({ detail: "No autenticado o token inválido" }, 401);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonResponse({ detail: "Cuerpo inválido: se espera multipart/form-data" }, 400);
  }

  const xmlFile = form.get("xml");
  if (!(xmlFile instanceof File)) {
    return jsonResponse({ detail: "Falta el archivo XML" }, 422);
  }
  const xmlBytes = new Uint8Array(await xmlFile.arrayBuffer());

  const pdfFile = form.get("pdf");
  const pdfBytes = pdfFile instanceof File ? new Uint8Array(await pdfFile.arrayBuffer()) : null;

  let result;
  try {
    result = await ingestInvoice(supabase, authUser, xmlBytes, xmlFile.name || "factura.xml", "web");
  } catch (exc) {
    console.error(`Error procesando factura subida por usuario ${authUser.id}:`, exc);
    return jsonResponse({ detail: "No se pudo procesar la factura" }, 500);
  }

  // Mismo patrón que sendgrid-webhook: el PDF solo se guarda si el XML se
  // aceptó (hay invoice_id + uuid) -- si el XML fue rechazado, no hay fila a
  // la cual enlazarlo.
  let pdfGuardado = false;
  if (pdfBytes && result.invoice_id && result.uuid) {
    const ruta = await subirPdf(supabase, authUser.id, result.uuid, pdfBytes);
    if (ruta) {
      const { error } = await supabase
        .schema("facturapp").from("invoices")
        .update({ pdf_path: ruta })
        .eq("id", result.invoice_id);
      if (error) {
        console.error(`No se pudo enlazar el PDF de ${result.uuid}:`, error);
      } else {
        pdfGuardado = true;
      }
    }
  }

  return jsonResponse({ ...result, pdf_guardado: pdfGuardado }, 200);
});
