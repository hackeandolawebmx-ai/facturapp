// Fase M5 — Webhook real de SendGrid (email inbound).
//
// Port 1:1 de ingest_email_sendgrid() en facturapp/facturapp/main.py.
// Más simple que el de WhatsApp (M4): no hay firma HMAC que verificar, no
// hay descarga remota de adjuntos (ya vienen en el payload), y no se
// responde por email (fuera de alcance de v1, igual que en Python).
//
// Fase M9 — acepta el multipart/form-data real de SendGrid Inbound Parse,
// además del JSON que asumía M5. Hasta M9 solo entendía JSON, igual que
// email_service.py, lo que dejaba el canal de correo sin funcionar de punta
// a punta en NINGUNA de las dos versiones. Es una divergencia deliberada
// respecto a Python: un webhook que no puede recibir lo que su proveedor
// envía no está terminado, solo declarado.
//
// Fase M10 — verificación de origen por secreto compartido. Python no la
// tiene, y mientras el canal no funcionaba era un caveat teórico; una vez
// que funciona, cualquiera que supiera la URL podía inyectar una factura
// falsa en la cuenta de otro usuario (basta con conocer su correo, porque
// la cuenta se crea sola). Ver verificarOrigenSendgrid() en email.ts para
// el porqué de un secreto compartido y no una firma.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, jsonHeaders } from "../_shared/cors.ts";
import {
  type CorreoRecibido, extractAttachments, extractSenderEmail,
  type EmailWebhookPayload, parseSendgridFormData, verificarOrigenSendgrid,
} from "../_shared/email.ts";
import { getOrCreateUserByEmail } from "../_shared/users.ts";
import { ingestInvoice } from "../_shared/invoices.ts";

function getSupabaseClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

/** Lee el correo entrante, venga como multipart real de SendGrid o como el
 * JSON que asumía M5.
 *
 * Se distingue por Content-Type y no por intentar parsear y ver qué pasa:
 * el cuerpo de una petición solo se puede consumir una vez, así que un
 * intento fallido dejaría el stream inutilizable para el segundo. */
async function leerCorreo(req: Request): Promise<CorreoRecibido | null> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    return await parseSendgridFormData(await req.formData());
  }

  const payload = await req.json() as EmailWebhookPayload;
  return {
    from: payload.from ?? "",
    to: payload.to ?? "",
    subject: payload.subject ?? "",
    adjuntos: extractAttachments(payload),
  };
}

async function handlePost(req: Request): Promise<Response> {
  // Mismo patrón que whatsapp-webhook con WHATSAPP_APP_SECRET: si el
  // secreto está configurado se exige; si no, se avisa y se deja pasar, para
  // no tumbar un despliegue existente en el momento de introducir esto. El
  // aviso queda en el log justamente para que no se olvide configurarlo.
  const secreto = Deno.env.get("SENDGRID_WEBHOOK_SECRET");
  if (secreto) {
    if (!verificarOrigenSendgrid(req, secreto)) {
      console.warn("Petición a sendgrid-webhook con secreto inválido o ausente");
      return new Response(JSON.stringify({ detail: "No autorizado" }), {
        status: 401,
        headers: jsonHeaders,
      });
    }
  } else {
    console.warn(
      "SENDGRID_WEBHOOK_SECRET no configurado: se omite la verificación de origen",
    );
  }

  let correo: CorreoRecibido | null;
  try {
    correo = await leerCorreo(req);
  } catch (exc) {
    console.error("No se pudo leer el correo entrante:", exc);
    return new Response(JSON.stringify({ detail: "Cuerpo inválido" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }
  if (!correo) {
    return new Response(JSON.stringify({ detail: "Cuerpo inválido" }), {
      status: 400,
      headers: jsonHeaders,
    });
  }

  const supabase = getSupabaseClient();
  const senderEmail = extractSenderEmail(correo.from);

  let user;
  try {
    user = await getOrCreateUserByEmail(supabase, senderEmail);
  } catch (exc) {
    console.error(`Error resolviendo usuario para ${senderEmail}:`, exc);
    return new Response(JSON.stringify({ detail: "No se pudo resolver el usuario" }), {
      status: 500,
      headers: jsonHeaders,
    });
  }

  const entries = Object.entries(correo.adjuntos) as Array<["xml" | "pdf", Uint8Array]>;

  if (entries.length === 0) {
    return new Response(JSON.stringify({
      user_id: user.id,
      estatus: "sin_adjuntos",
      mensaje: "No encontramos ningún adjunto XML o PDF en el correo.",
    }), {
      status: 202,
      headers: jsonHeaders,
    });
  }

  // Si el correo trae XML, el PDF no se procesa como si fuera una factura
  // suelta: al hacerlo, `ingestInvoice` respondía "Solo recibimos el PDF,
  // necesitas el XML para deducir" a alguien que SÍ había mandado el XML.
  // Decirle a un usuario que le falta algo que sí envió es peor que no
  // decirle nada.
  const aProcesar = correo.adjuntos.xml
    ? entries.filter(([kind]) => kind === "xml")
    : entries;

  const resultados: Array<Record<string, unknown>> = [];
  for (const [kind, contenido] of aProcesar) {
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
    headers: jsonHeaders,
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
