/**
 * Tests de la lógica pura del webhook de email (Fase M5) — port de los
 * casos cubiertos por test_email.py en la versión Python (Fase 3a).
 */
import { assertEquals } from "jsr:@std/assert@1";
import { extractAttachments, extractSenderEmail } from "./email.ts";

// `btoa` en vez de Buffer: el runtime de Edge Functions no tiene Buffer, y
// el test debe usar las mismas APIs que el código de producción.
const b64 = (s: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// ---- extractSenderEmail -----------------------------------------------------

Deno.test("extractSenderEmail: dirección pura sin nombre", () => {
  assertEquals(extractSenderEmail("nueva@example.com"), "nueva@example.com");
});

Deno.test("extractSenderEmail: formato 'Nombre <email>'", () => {
  assertEquals(
    extractSenderEmail('"Daniela Ávila" <daniela.display@example.com>'),
    "daniela.display@example.com",
  );
});

Deno.test("extractSenderEmail: normaliza a minúsculas", () => {
  assertEquals(extractSenderEmail("NUEVA@EXAMPLE.COM"), "nueva@example.com");
});

// ---- extractAttachments ------------------------------------------------------

function payload(attachments: Array<{ filename: string; content: string }>) {
  return { from: "x@example.com", to: "daniel@facturapp.mx", attachments };
}

Deno.test("extractAttachments: un XML se clasifica como xml", () => {
  const result = extractAttachments(payload([
    { filename: "factura.xml", content: b64("<xml/>") },
  ]));
  assertEquals(Object.keys(result), ["xml"]);
});

Deno.test("extractAttachments: un PDF se clasifica como pdf", () => {
  const result = extractAttachments(payload([
    { filename: "factura.pdf", content: b64("%PDF-1.4") },
  ]));
  assertEquals(Object.keys(result), ["pdf"]);
});

Deno.test("extractAttachments: XML + PDF juntos → ambas claves", () => {
  const result = extractAttachments(payload([
    { filename: "factura.xml", content: b64("<xml/>") },
    { filename: "factura.pdf", content: b64("%PDF-1.4") },
  ]));
  assertEquals(new Set(Object.keys(result)), new Set(["xml", "pdf"]));
});

Deno.test("extractAttachments: dos XML — se queda con el ÚLTIMO (igual que Python)", () => {
  const result = extractAttachments(payload([
    { filename: "factura1.xml", content: b64("PRIMERO") },
    { filename: "factura2.xml", content: b64("SEGUNDO") },
  ]));
  assertEquals(new TextDecoder().decode(result.xml), "SEGUNDO");
});

Deno.test("extractAttachments: extensión no reconocida se ignora", () => {
  const result = extractAttachments(payload([
    { filename: "nota.txt", content: b64("solo texto") },
  ]));
  assertEquals(Object.keys(result), []);
});

Deno.test("extractAttachments: sin adjuntos devuelve objeto vacío", () => {
  assertEquals(extractAttachments(payload([])), {});
});

Deno.test("extractAttachments: base64 corrupto se ignora silenciosamente", () => {
  const result = extractAttachments(payload([
    { filename: "factura.xml", content: "%%%no-es-base64%%%" },
  ]));
  assertEquals(Object.keys(result), []);
});
