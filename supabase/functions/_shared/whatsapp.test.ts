/**
 * Tests de la lógica pura del webhook de WhatsApp (Fase M4) — port de
 * los casos cubiertos por test_whatsapp.py en la versión Python (Fase 3b).
 *
 * Solo lo puro: firma HMAC, extracción de mensajes, mapeo de respuesta.
 * Lo que hace I/O real (descarga de media, envío de mensaje) no se testea
 * aquí — ver README para el smoke test manual post-deploy.
 */
import { createHmac } from "node:crypto";
import { assertEquals } from "jsr:@std/assert@1";
import {
  extractWhatsappInteractiveReplies, extractWhatsappMessages, extractWhatsappTextMessages,
  verifyWhatsappSignature, whatsappReplyText,
} from "./whatsapp.ts";

const enc = (s: string) => new TextEncoder().encode(s);

// ---- Firma HMAC ------------------------------------------------------------

Deno.test("verifyWhatsappSignature: firma válida", () => {
  const body = enc('{"a":1}');
  const secret = "shhh";
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  assertEquals(verifyWhatsappSignature(body, sig, secret), true);
});

Deno.test("verifyWhatsappSignature: firma inválida", () => {
  const body = enc('{"a":1}');
  assertEquals(verifyWhatsappSignature(body, "sha256=" + "0".repeat(64), "shhh"), false);
});

Deno.test("verifyWhatsappSignature: header ausente", () => {
  assertEquals(verifyWhatsappSignature(enc("{}"), null, "shhh"), false);
});

Deno.test("verifyWhatsappSignature: esquema incorrecto (no sha256=)", () => {
  assertEquals(verifyWhatsappSignature(enc("{}"), "plain=abc", "shhh"), false);
});

Deno.test("verifyWhatsappSignature: secreto distinto produce firma distinta", () => {
  const body = enc('{"a":1}');
  const sig = "sha256=" + createHmac("sha256", "otro-secreto").update(body).digest("hex");
  assertEquals(verifyWhatsappSignature(body, sig, "shhh"), false);
});

// ---- Extracción de mensajes -------------------------------------------------

function metaDocumentPayload(
  phone: string,
  opts: { mediaId?: string; filename?: string; profileName?: string } = {},
) {
  const contact: Record<string, unknown> = { wa_id: phone };
  if (opts.profileName) contact.profile = { name: opts.profileName };
  return {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA_ID",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          contacts: [contact],
          messages: [{
            from: phone, id: "wamid.XXX", type: "document",
            document: {
              id: opts.mediaId ?? "MEDIA123",
              mime_type: "text/xml",
              filename: opts.filename ?? "factura.xml",
            },
          }],
        },
      }],
    }],
  };
}

Deno.test("extractWhatsappMessages: extrae documento con remitente y media_id", () => {
  const payload = metaDocumentPayload("5511111111111", { mediaId: "M9", filename: "f.pdf" });
  const messages = extractWhatsappMessages(payload);
  assertEquals(messages.length, 1);
  assertEquals(messages[0].media_id, "M9");
  assertEquals(messages[0].filename, "f.pdf");
  assertEquals(messages[0].from, "5511111111111");
});

Deno.test("extractWhatsappMessages: ignora mensajes que no son document", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { from: "555", type: "text", text: { body: "hola" } },
    ] } }] }],
  };
  assertEquals(extractWhatsappMessages(payload), []);
});

Deno.test("extractWhatsappMessages: usa el profile_name del contacto", () => {
  const payload = metaDocumentPayload("5511111111111", { profileName: "Cliente WA" });
  const messages = extractWhatsappMessages(payload);
  assertEquals(messages[0].profile_name, "Cliente WA");
});

Deno.test("extractWhatsappMessages: documento sin media_id se ignora", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { from: "555", type: "document", document: { filename: "x.xml" } },
    ] } }] }],
  };
  assertEquals(extractWhatsappMessages(payload), []);
});

Deno.test("extractWhatsappMessages: payload vacío devuelve []", () => {
  assertEquals(extractWhatsappMessages({}), []);
});

// ---- Extracción de mensajes de texto (Fase M4b) -----------------------------

Deno.test("extractWhatsappTextMessages: extrae texto con remitente y profile_name", () => {
  const payload = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: "555", profile: { name: "Cliente WA" } }],
      messages: [{ from: "555", type: "text", text: { body: "¿cuánto llevo?" } }],
    } }] }],
  };
  const messages = extractWhatsappTextMessages(payload);
  assertEquals(messages.length, 1);
  assertEquals(messages[0], { from: "555", text: "¿cuánto llevo?", profile_name: "Cliente WA" });
});

Deno.test("extractWhatsappTextMessages: ignora mensajes que no son text", () => {
  const payload = metaDocumentPayload("5511111111111");
  assertEquals(extractWhatsappTextMessages(payload), []);
});

Deno.test("extractWhatsappTextMessages: texto vacío (solo espacios) se ignora", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { from: "555", type: "text", text: { body: "   " } },
    ] } }] }],
  };
  assertEquals(extractWhatsappTextMessages(payload), []);
});

// ---- extractWhatsappInteractiveReplies (Fase M21) ---------------------------

Deno.test("extractWhatsappInteractiveReplies: extrae id de list_reply con remitente y profile_name", () => {
  const payload = {
    entry: [{ changes: [{ value: {
      contacts: [{ wa_id: "555", profile: { name: "Cliente WA" } }],
      messages: [{
        from: "555", type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "menu_resumen", title: "💰 ¿Cuánto llevo?" } },
      }],
    } }] }],
  };
  const replies = extractWhatsappInteractiveReplies(payload);
  assertEquals(replies.length, 1);
  assertEquals(replies[0], { from: "555", id: "menu_resumen", profile_name: "Cliente WA" });
});

Deno.test("extractWhatsappInteractiveReplies: ignora mensajes que no son interactive", () => {
  const payload = metaDocumentPayload("5511111111111");
  assertEquals(extractWhatsappInteractiveReplies(payload), []);
});

Deno.test("extractWhatsappInteractiveReplies: ignora interactive que no es list_reply (ej. button_reply)", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { from: "555", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "x" } } },
    ] } }] }],
  };
  assertEquals(extractWhatsappInteractiveReplies(payload), []);
});

Deno.test("extractWhatsappInteractiveReplies: list_reply sin id se ignora", () => {
  const payload = {
    entry: [{ changes: [{ value: { messages: [
      { from: "555", type: "interactive", interactive: { type: "list_reply", list_reply: {} } },
    ] } }] }],
  };
  assertEquals(extractWhatsappInteractiveReplies(payload), []);
});

Deno.test("extractWhatsappInteractiveReplies: payload vacío devuelve []", () => {
  assertEquals(extractWhatsappInteractiveReplies({}), []);
});

Deno.test("extractWhatsappTextMessages: payload vacío devuelve []", () => {
  assertEquals(extractWhatsappTextMessages({}), []);
});

// ---- Mapeo de estatus → mensaje de WhatsApp ---------------------------------

Deno.test("whatsappReplyText: valida", () => {
  const msg = whatsappReplyText({ estatus: "valida", categoria: "Médicos", hallazgos: [] });
  assertEquals(msg, "✅ Factura recibida y clasificada como Médicos. ¡Gracias!");
});

Deno.test("whatsappReplyText: advertencia usa el primer hallazgo", () => {
  const msg = whatsappReplyText({
    estatus: "advertencia",
    hallazgos: [{ mensaje: "Pagada en efectivo..." }],
  });
  assertEquals(msg, "⚠️ Factura recibida, pero: Pagada en efectivo...");
});

Deno.test("whatsappReplyText: rechazada", () => {
  const msg = whatsappReplyText({
    estatus: "rechazada",
    hallazgos: [{ mensaje: "Ya tenías registrada esta factura" }],
  });
  assertEquals(msg, "❌ No pudimos procesar tu factura: Ya tenías registrada esta factura");
});

Deno.test("whatsappReplyText: por_revisar", () => {
  const msg = whatsappReplyText({ estatus: "por_revisar", hallazgos: [] });
  assertEquals(
    msg,
    "📄 Recibimos tu PDF, pero necesitamos el XML para poder deducir esta factura.",
  );
});

Deno.test("whatsappReplyText: estatus desconocido usa el mensaje por defecto", () => {
  const msg = whatsappReplyText({ estatus: undefined, hallazgos: [] });
  assertEquals(msg, "Recibimos tu mensaje, pero no encontramos ninguna factura válida.");
});

// ---- archivada (Fase M14 — persona moral) -----------------------------------
//
// Encontrado en producción: sin esta rama, una factura de empresa que se
// archivó CORRECTAMENTE recibía el mensaje por defecto de "no encontramos
// ninguna factura válida" — falso, porque sí se encontró y sí se guardó.

Deno.test("whatsappReplyText: archivada (persona moral) NO cae en el mensaje por defecto", () => {
  const msg = whatsappReplyText({
    estatus: "archivada",
    hallazgos: [{
      mensaje: "Archivada para tu empresa. No evaluamos deducibilidad de personas morales.",
    }],
  });
  assertEquals(
    msg,
    "📁 Archivada para tu empresa. No evaluamos deducibilidad de personas morales.",
  );
});

Deno.test("whatsappReplyText: archivada reutiliza el mensaje del hallazgo, no uno propio", () => {
  // Misma fuente de verdad que advertencia/rechazada: el texto vive en
  // archivarSinEvaluar() (invoices.ts), no duplicado aquí.
  const msg = whatsappReplyText({
    estatus: "archivada",
    hallazgos: [{ mensaje: "texto de prueba distintivo" }],
  });
  assertEquals(msg, "📁 texto de prueba distintivo");
});
