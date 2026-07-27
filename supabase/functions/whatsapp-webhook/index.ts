// Fase M4 — Webhook real de WhatsApp (Meta Cloud API).
//
// GET: handshake de verificación (sin cambios desde M1).
// POST: verifica firma HMAC → extrae mensajes con documento → por cada uno:
//   resuelve/crea usuario por teléfono → descarga el adjunto (Graph API,
//   dos pasos) → parsea/valida/clasifica/guarda (ingestInvoice, compartido
//   con el futuro webhook de SendGrid) → responde por WhatsApp.
//
// Siempre responde 200 a Meta, salvo firma inválida (401) — un fallo al
// descargar o enviar un mensaje individual se registra y NO rompe el resto
// del batch (mismo comportamiento que whatsapp_webhook() en main.py).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "@supabase/supabase-js";
import { corsHeaders } from "../_shared/cors.ts";
import {
  downloadMediaFromMeta, extractWhatsappMessages, sendWhatsappMessage,
  verifyWhatsappSignature, whatsappReplyText,
} from "../_shared/whatsapp.ts";
import { getOrCreateUserByPhone } from "../_shared/users.ts";
import { ingestInvoice } from "../_shared/invoices.ts";

// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY vienen inyectadas automáticamente
// en runtime por Supabase — no requieren `supabase secrets set`.
function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

async function handleVerification(url: URL): Promise<Response> {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");

  if (mode === "subscribe" && token === verifyToken) {
    return new Response(challenge, { status: 200, headers: corsHeaders });
  }
  return new Response("Verificación fallida", { status: 403, headers: corsHeaders });
}

async function handleIncoming(req: Request): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  const signature = req.headers.get("X-Hub-Signature-256");
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");

  if (appSecret) {
    if (!verifyWhatsappSignature(bodyBytes, signature, appSecret)) {
      console.warn("Firma de WhatsApp inválida");
      return new Response(JSON.stringify({ detail: "Firma inválida" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    console.warn("WHATSAPP_APP_SECRET no configurado: se omite verificación de firma");
  }

  let payload: { entry?: unknown[] };
  try {
    payload = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    return new Response(JSON.stringify({ detail: "JSON inválido" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const mensajes = extractWhatsappMessages(payload);
  const supabase = getSupabaseClient();
  const whatsappToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";

  const resultados: Array<Record<string, unknown>> = [];

  for (const msg of mensajes) {
    let user;
    try {
      user = await getOrCreateUserByPhone(supabase, msg.from, msg.profile_name);
    } catch (exc) {
      console.error(`Error resolviendo usuario para ${msg.from}:`, exc);
      resultados.push({ from: msg.from, error: "No se pudo resolver el usuario" });
      continue;
    }

    let contenido: Uint8Array;
    try {
      const media = await downloadMediaFromMeta(msg.media_id, whatsappToken);
      contenido = media.content;
    } catch (exc) {
      console.error(`Error descargando adjunto de WhatsApp (media_id=${msg.media_id}):`, exc);
      resultados.push({ from: msg.from, error: "No se pudo descargar el adjunto de WhatsApp" });
      continue;
    }

    let ingestResult;
    try {
      ingestResult = await ingestInvoice(supabase, user, contenido, msg.filename);
    } catch (exc) {
      console.error(`Error procesando factura de ${msg.from}:`, exc);
      resultados.push({ from: msg.from, error: "No se pudo procesar la factura" });
      continue;
    }

    resultados.push({ from: msg.from, ...ingestResult });

    try {
      await sendWhatsappMessage(
        msg.from, whatsappReplyText(ingestResult), whatsappToken, phoneNumberId,
      );
    } catch (exc) {
      console.error(`No se pudo enviar la respuesta de WhatsApp a ${msg.from}:`, exc);
    }
  }

  return new Response(JSON.stringify({ resultados }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);

  if (req.method === "GET") {
    return handleVerification(url);
  }

  if (req.method === "POST") {
    return handleIncoming(req);
  }

  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
