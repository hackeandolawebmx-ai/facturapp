// Fase M4 — Webhook real de WhatsApp (Meta Cloud API).
// Fase M4b — se agrega chat conversacional (texto) reusando chat.ts (M5.5).
//
// GET: handshake de verificación (sin cambios desde M1).
// POST: verifica firma HMAC → extrae mensajes:
//   - "document" → resuelve/crea usuario por teléfono → descarga el
//     adjunto (Graph API, dos pasos) → parsea/valida/clasifica/guarda
//     (ingestInvoice, compartido con sendgrid-webhook) → responde.
//   - "text" → resuelve/crea usuario por teléfono → comando rápido (sin IA)
//     o chat() con historial de chat_messages → guarda el turno → responde.
//
// Siempre responde 200 a Meta, salvo firma inválida (401) — un fallo al
// procesar un mensaje individual se registra (console + debug_logs) y NO
// rompe el resto del batch (mismo comportamiento que whatsapp_webhook() en
// main.py para documentos; el manejo de texto es una extensión M4b sin
// equivalente en Python — ver chat.ts y whatsapp.ts para el detalle de la
// divergencia).
//
// El patrón de esta fase (comandos rápidos antes de IA, log a debug_logs,
// historial de conversación, dispatch por tipo de mensaje) está adoptado
// de WHATSAPP_BOT_ARCHITECTURE.md — arquitectura ya probada en producción
// en otro proyecto sobre el mismo Supabase.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import {
  downloadMediaFromMeta, extractWhatsappMessages, extractWhatsappTextMessages,
  sendWhatsappMessage, verifyWhatsappSignature, whatsappReplyText,
} from "../_shared/whatsapp.ts";
import {
  esPeticionDeEnlaceWeb, interceptQuickCommand, mensajeEnlaceAlta,
  mensajeEnlaceLogin, MENSAJE_WEB_NO_DISPONIBLE,
} from "../_shared/whatsapp_commands.ts";
import { getOrCreateUserByPhone, getUserAuth } from "../_shared/users.ts";
import { ingestInvoice } from "../_shared/invoices.ts";
import { chat, getRecentChatHistory, realChatCompletion } from "../_shared/chat.ts";
import { logDebug } from "../_shared/debug_log.ts";

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

async function handleTextMessage(
  // deno-lint-ignore no-explicit-any
  supabase: any, msg: { from: string; text: string; profile_name: string | null },
  whatsappToken: string, phoneNumberId: string,
): Promise<Record<string, unknown>> {
  const user = await getOrCreateUserByPhone(supabase, msg.from, msg.profile_name);

  const quickReply = interceptQuickCommand(msg.text);
  if (quickReply !== null) {
    await logDebug(supabase, "whatsapp: comando rápido", { from: msg.from, text: msg.text });
    await sendWhatsappMessage(msg.from, quickReply, whatsappToken, phoneNumberId);
    return { from: msg.from, tipo: "comando_rapido" };
  }

  // Acceso a la web (M12). Va aquí y no en interceptQuickCommand porque la
  // respuesta depende del usuario: si aún no tiene contraseña necesita el
  // enlace con su web_token para crearla, y si ya la tiene basta la dirección.
  //
  // Es el único camino por el que un usuario de WhatsApp puede llegar a la
  // web: su cuenta se creó sola al mandar una factura, nace sin contraseña, y
  // sin esto no habría forma de establecerla salvo leyendo la base a mano.
  if (esPeticionDeEnlaceWeb(msg.text)) {
    const urlDashboard = Deno.env.get("DASHBOARD_URL");
    let respuesta: string;
    if (!urlDashboard) {
      respuesta = MENSAJE_WEB_NO_DISPONIBLE;
    } else {
      const credenciales = await getUserAuth(supabase, user.id);
      respuesta = credenciales?.hashed_password || !credenciales?.web_token
        ? mensajeEnlaceLogin(urlDashboard)
        : mensajeEnlaceAlta(urlDashboard, credenciales.web_token);
    }
    await logDebug(supabase, "whatsapp: enlace web", { from: msg.from });
    await sendWhatsappMessage(msg.from, respuesta, whatsappToken, phoneNumberId);
    return { from: msg.from, tipo: "enlace_web" };
  }

  await supabase.schema("facturapp").from("chat_messages")
    .insert({ user_id: user.id, role: "user", content: msg.text });

  const history = await getRecentChatHistory(supabase, user.id);
  const apiKey = Deno.env.get("OPENAI_API_KEY") ?? "";
  const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-4o";

  const result = await chat(
    supabase, user, msg.text,
    (messages, tools) => realChatCompletion(messages, tools, apiKey, model),
    history,
  );

  await supabase.schema("facturapp").from("chat_messages")
    .insert({ user_id: user.id, role: "assistant", content: result.response });

  await logDebug(supabase, "whatsapp: chat respondido", {
    from: msg.from, tools_used: result.tools_used,
  });

  await sendWhatsappMessage(msg.from, result.response, whatsappToken, phoneNumberId);
  return { from: msg.from, tipo: "chat", tools_used: result.tools_used };
}

async function handleIncoming(req: Request): Promise<Response> {
  const bodyBytes = new Uint8Array(await req.arrayBuffer());
  const signature = req.headers.get("X-Hub-Signature-256");
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");
  const supabase = getSupabaseClient();

  if (appSecret) {
    if (!verifyWhatsappSignature(bodyBytes, signature, appSecret)) {
      console.warn("Firma de WhatsApp inválida");
      await logDebug(supabase, "whatsapp: firma inválida", { signature });
      return new Response(JSON.stringify({ detail: "Firma inválida" }), {
        status: 401,
        headers: jsonHeaders,
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
      headers: jsonHeaders,
    });
  }

  const documentos = extractWhatsappMessages(payload);
  const textos = extractWhatsappTextMessages(payload);
  const whatsappToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN") ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";

  const resultados: Array<Record<string, unknown>> = [];

  for (const msg of documentos) {
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
      await logDebug(supabase, "whatsapp: error descargando adjunto", { from: msg.from, error: String(exc) });
      resultados.push({ from: msg.from, error: "No se pudo descargar el adjunto de WhatsApp" });
      continue;
    }

    let ingestResult;
    try {
      ingestResult = await ingestInvoice(supabase, user, contenido, msg.filename);
    } catch (exc) {
      console.error(`Error procesando factura de ${msg.from}:`, exc);
      await logDebug(supabase, "whatsapp: error procesando factura", { from: msg.from, error: String(exc) });
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

  for (const msg of textos) {
    try {
      resultados.push(await handleTextMessage(supabase, msg, whatsappToken, phoneNumberId));
    } catch (exc) {
      console.error(`Error procesando mensaje de texto de ${msg.from}:`, exc);
      await logDebug(supabase, "whatsapp: error en chat", { from: msg.from, error: String(exc) });
      resultados.push({ from: msg.from, error: "No se pudo procesar tu mensaje" });
    }
  }

  return new Response(JSON.stringify({ resultados }), {
    status: 200,
    headers: jsonHeaders,
  });
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      return await handleVerification(url);
    }

    if (req.method === "POST") {
      return await handleIncoming(req);
    }
  } catch (exc) {
    // Red de seguridad para excepciones INESPERADAS. Los fallos por mensaje
    // ya se manejan dentro de handleIncoming; esto atrapa lo que se escape
    // de ahí (incluido un fallo del propio logDebug dentro de un catch).
    //
    // Sin esto, una excepción aquí producía un 500 con cuerpo text/plain del
    // runtime de Deno: sin rastro en debug_logs, sin detalle en el log, y
    // rompiendo el contrato de respuesta documentado arriba. Fue justo lo
    // que ocultó el primer fallo real al conectar Meta.
    //
    // Se responde 500 a propósito (y no 200): así Meta reintenta la entrega
    // —dando una segunda oportunidad al mensaje— y el fallo queda visible en
    // el dashboard en vez de aparentar éxito. Un mensaje perdido en silencio
    // es peor que un reintento en una app fiscal.
    console.error("Excepción no controlada en whatsapp-webhook:", exc);
    try {
      await logDebug(getSupabaseClient(), "whatsapp: excepción no controlada", {
        error: String(exc),
        stack: exc instanceof Error ? exc.stack : undefined,
      });
    } catch (logExc) {
      console.error("Además falló el registro en debug_logs:", logExc);
    }
    return new Response(JSON.stringify({ detail: "Error interno" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  return new Response("Método no soportado", { status: 405, headers: corsHeaders });
});
