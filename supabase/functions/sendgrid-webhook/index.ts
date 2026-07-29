// Fase M5 — Webhook real de SendGrid (email inbound).
//
// Port 1:1 de ingest_email_sendgrid() en facturapp/facturapp/main.py.
// Más simple que el de WhatsApp (M4): no hay firma HMAC que verificar, no
// hay descarga remota de adjuntos (ya vienen en el payload), y no se
// responde por email (fuera de alcance de v1, igual que en Python).
//
// ⚠️ Sin verificación de firma/origen — mismo caveat que la versión Python:
// cualquiera que sepa el email de un usuario podría, en teoría, enviar un
// POST directo simulando ser SendGrid. Para producción, agregar
// verificación de IP de SendGrid o un secreto compartido en la URL.
//
// ⚠️ Asume el mismo adaptador JSON que la versión Python — SendGrid Inbound
// Parse real envía multipart/form-data; no se construyó un parser de eso
// aquí porque el sistema de referencia tampoco lo tiene (ver README).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { extractAttachments, extractSenderEmail, type EmailWebhookPayload } from "../_shared/email.ts";
import { getOrCreateUserByEmail } from "../_shared/users.ts";
import { ingestInvoice } from "../_shared/invoices.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function handlePost(req: Request): Promise<Response> {
  let payload: EmailWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ detail: "JSON inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = getSupabaseClient();
  const senderEmail = extractSenderEmail(payload.from);

  let user;
  try {
    user = await getOrCreateUserByEmail(supabase, senderEmail);
  } catch (exc) {
    console.error(`Error resolviendo usuario para ${senderEmail}:`, exc);
    return new Response(JSON.stringify({ detail: "No se pudo resolver el usuario" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const attachments = extractAttachments(payload);
  const entries = Object.entries(attachments) as Array<["xml" | "pdf", Uint8Array]>;

  if (entries.length === 0) {
    return new Response(JSON.stringify({
      user_id: user.id,
      estatus: "sin_adjuntos",
      mensaje: "No encontramos ningún adjunto XML o PDF en el correo.",
    }), {
      status: 202,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const resultados: Array<Record<string, unknown>> = [];
  for (const [kind, contenido] of entries) {
    const filename = `attachment.${kind}`;
    try {
      const result = await ingestInvoice(supabase, user, contenido, filename);
      resultados.push({ filename, ...result });
    } catch (exc) {
      console.error(`Error procesando adjunto ${filename} de ${senderEmail}:`, exc);
      resultados.push({ filename, error: "No se pudo procesar la factura" });
    }
  }

  return new Response(JSON.stringify({ user_id: user.id, resultados }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method === "POST") {
    return handlePost(req);
  }
  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
