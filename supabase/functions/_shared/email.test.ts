/**
 * Tests de la lógica pura del webhook de email (Fase M5) — port de los
 * casos cubiertos por test_email.py en la versión Python (Fase 3a).
 */
import { assertEquals } from "jsr:@std/assert@1";
import { extractAttachments, extractSenderEmail, parseSendgridFormData } from "./email.ts";

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

// ---- parseSendgridFormData (Fase M9) ----------------------------------------
//
// Es el formato REAL de SendGrid Inbound Parse. Hasta M9 el webhook solo
// entendía JSON, así que este canal no funcionaba de punta a punta.

/** Construye una FormData como la que manda SendGrid. */
function formDataDeSendgrid(
  campos: Record<string, string>,
  adjuntos: Array<{ campo: string; filename: string; contenido: string }> = [],
): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, v);
  for (const a of adjuntos) {
    form.append(a.campo, new File([a.contenido], a.filename), a.filename);
  }
  return form;
}

Deno.test("parseSendgridFormData: extrae los campos de texto del correo", async () => {
  const correo = await parseSendgridFormData(formDataDeSendgrid({
    from: "Daniela Ávila <daniela@example.com>",
    to: "facturas@facturapp.mx",
    subject: "Factura de julio",
  }));
  assertEquals(correo.from, "Daniela Ávila <daniela@example.com>");
  assertEquals(correo.to, "facturas@facturapp.mx");
  assertEquals(correo.subject, "Factura de julio");
});

Deno.test("parseSendgridFormData: extrae un XML adjunto como bytes", async () => {
  const correo = await parseSendgridFormData(formDataDeSendgrid(
    { from: "a@b.com", to: "c@d.com" },
    [{ campo: "attachment1", filename: "factura.xml", contenido: "<cfdi/>" }],
  ));
  assertEquals(new TextDecoder().decode(correo.adjuntos.xml), "<cfdi/>");
  assertEquals(correo.adjuntos.pdf, undefined);
});

Deno.test("parseSendgridFormData: XML y PDF juntos → ambas claves", async () => {
  const correo = await parseSendgridFormData(formDataDeSendgrid(
    { from: "a@b.com", to: "c@d.com" },
    [
      { campo: "attachment1", filename: "factura.xml", contenido: "<cfdi/>" },
      { campo: "attachment2", filename: "factura.pdf", contenido: "%PDF-1.4" },
    ],
  ));
  assertEquals(new TextDecoder().decode(correo.adjuntos.xml), "<cfdi/>");
  assertEquals(new TextDecoder().decode(correo.adjuntos.pdf), "%PDF-1.4");
});

Deno.test("parseSendgridFormData: dos XML → se queda con el ÚLTIMO", async () => {
  // Misma regla que la variante JSON, para que el comportamiento no dependa
  // del formato en que llegue el correo.
  const correo = await parseSendgridFormData(formDataDeSendgrid(
    { from: "a@b.com", to: "c@d.com" },
    [
      { campo: "attachment1", filename: "primera.xml", contenido: "<primera/>" },
      { campo: "attachment2", filename: "segunda.xml", contenido: "<segunda/>" },
    ],
  ));
  assertEquals(new TextDecoder().decode(correo.adjuntos.xml), "<segunda/>");
});

Deno.test("parseSendgridFormData: ignora adjuntos con extensión no reconocida", async () => {
  const correo = await parseSendgridFormData(formDataDeSendgrid(
    { from: "a@b.com", to: "c@d.com" },
    [{ campo: "attachment1", filename: "firma.png", contenido: "PNG" }],
  ));
  assertEquals(Object.keys(correo.adjuntos), []);
});

Deno.test("parseSendgridFormData: encuentra el adjunto aunque el campo no se llame attachmentN", async () => {
  // Se recorre toda la FormData en vez de buscar attachment1..N: si el
  // proveedor cambia el nombre del campo, o el contador `attachments` no
  // coincide, un adjunto se perdería en silencio.
  const correo = await parseSendgridFormData(formDataDeSendgrid(
    { from: "a@b.com", to: "c@d.com", attachments: "0" },
    [{ campo: "archivo_raro", filename: "factura.xml", contenido: "<cfdi/>" }],
  ));
  assertEquals(new TextDecoder().decode(correo.adjuntos.xml), "<cfdi/>");
});

Deno.test("parseSendgridFormData: correo sin adjuntos devuelve objeto vacío", async () => {
  const correo = await parseSendgridFormData(formDataDeSendgrid({
    from: "a@b.com", to: "c@d.com", subject: "solo texto",
  }));
  assertEquals(Object.keys(correo.adjuntos), []);
});

Deno.test("parseSendgridFormData: campos ausentes son cadena vacía, nunca undefined", async () => {
  const correo = await parseSendgridFormData(formDataDeSendgrid({ from: "a@b.com" }));
  assertEquals(correo.to, "");
  assertEquals(correo.subject, "");
});
