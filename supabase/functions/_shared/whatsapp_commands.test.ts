import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  esPeticionDeEnlaceWeb, esPeticionDeRecuperarPassword, esPeticionDeEnvioFacturas,
  interceptQuickCommand, mensajeEnlaceAlta, mensajeEnlaceLogin, mensajeEnlaceReset,
  mensajeFormasEnvio,
} from "./whatsapp_commands.ts";

Deno.test("interceptQuickCommand: saludo simple devuelve respuesta fija", () => {
  const reply = interceptQuickCommand("hola");
  assert(reply !== null);
  assert(reply!.toLowerCase().includes("asistente"));
});

Deno.test("interceptQuickCommand: variantes de saludo con mayúsculas/puntuación", () => {
  assert(interceptQuickCommand("Hola!") !== null);
  assert(interceptQuickCommand("buenas tardes.") !== null);
});

Deno.test("interceptQuickCommand: 'ayuda' devuelve el listado de comandos", () => {
  const reply = interceptQuickCommand("ayuda");
  assert(reply !== null);
  assert(reply!.includes("Registrar una factura"));
});

Deno.test("interceptQuickCommand: pregunta real NO se intercepta (pasa a OpenAI)", () => {
  assertEquals(interceptQuickCommand("hola, cuánto llevo en médicos"), null);
  assertEquals(interceptQuickCommand("¿qué puedo deducir este año?"), null);
});

Deno.test("interceptQuickCommand: mensaje no relacionado devuelve null", () => {
  assertEquals(interceptQuickCommand("mis facturas de julio"), null);
});

// ---- Acceso a la web (Fase M12) ---------------------------------------------
//
// Es el único camino por el que un usuario de WhatsApp llega a la plataforma:
// su cuenta nace sin contraseña y sin esto no hay forma de establecerla.

Deno.test("esPeticionDeEnlaceWeb: reconoce las formas naturales de pedirlo", () => {
  const frases = [
    "quiero entrar a la web",
    "cómo accedo a la plataforma",
    "mándame el link de la página",
    "quiero ver mi dashboard",
    "dame acceso al portal",
    "como entro desde la computadora",
    "web",
    "necesito la liga del sitio",
    "puedo abrir la pagina en internet?",
  ];
  for (const frase of frases) {
    assert(esPeticionDeEnlaceWeb(frase), `no reconoció: ${frase}`);
  }
});

Deno.test("esPeticionDeEnlaceWeb: NO intercepta consultas fiscales", () => {
  // Este es el riesgo real de un patrón amplio: robarle a OpenAI una
  // pregunta legítima y contestar con un enlace que nadie pidió.
  const frases = [
    "cuánto llevo en médicos",
    "mis facturas de julio",
    "qué puedo deducir",
    "cambia esa factura a colegiaturas",
    "cuál es el tope de deducciones",
    "mándame el resumen del año",
  ];
  for (const frase of frases) {
    assertEquals(esPeticionDeEnlaceWeb(frase), false, `interceptó de más: ${frase}`);
  }
});

Deno.test("mensajeEnlaceAlta: incluye el token y advierte que es personal", () => {
  const m = mensajeEnlaceAlta("https://facturapp.mx/dashboard.html", "TOK123");
  assert(m.includes("https://facturapp.mx/dashboard.html?token=TOK123"));
  assert(m.toLowerCase().includes("no lo compartas"));
});

Deno.test("mensajeEnlaceAlta: escapa el token en la URL", () => {
  const m = mensajeEnlaceAlta("https://x.mx/d.html", "a b&c");
  assert(m.includes("token=a%20b%26c"));
});

Deno.test("mensajeEnlaceLogin: NO incluye ningún token", () => {
  // Si la cuenta ya tiene contraseña, el web_token no sirve para el alta y
  // mandarlo sería filtrar una credencial sin ninguna razón.
  const m = mensajeEnlaceLogin("https://facturapp.mx/dashboard.html");
  assertEquals(m.includes("token="), false);
  assert(m.includes("https://facturapp.mx/dashboard.html"));
});

// ---- Recuperar contraseña (Fase M17) ---------------------------------------

Deno.test("esPeticionDeRecuperarPassword: reconoce las formas naturales de pedirlo", () => {
  const frases = [
    "olvidé mi contraseña",
    "olvide mi password",
    "quiero recuperar mi contraseña",
    "no recuerdo mi contraseña",
    "no me acuerdo de mi password",
    "cómo restablezco mi contraseña",
    "resetear contraseña",
    "perdí mi contraseña",
  ];
  for (const frase of frases) {
    assert(esPeticionDeRecuperarPassword(frase), `no reconoció: ${frase}`);
  }
});

Deno.test("esPeticionDeRecuperarPassword: NO intercepta consultas fiscales ni el pedido de entrar a la web", () => {
  const frases = [
    "cuánto llevo en médicos",
    "mis facturas de julio",
    "quiero entrar a la web",
    "cómo accedo a la plataforma",
  ];
  for (const frase of frases) {
    assertEquals(esPeticionDeRecuperarPassword(frase), false, `interceptó de más: ${frase}`);
  }
});

Deno.test("mensajeEnlaceReset: incluye el reset_token y advierte vigencia/no compartir", () => {
  const m = mensajeEnlaceReset("https://facturapp.mx/dashboard.html", "RESET123");
  assert(m.includes("https://facturapp.mx/dashboard.html?reset_token=RESET123"));
  assert(m.includes("30 minutos"));
  assert(m.toLowerCase().includes("no lo compartas"));
});

// ---- Dónde enviar facturas ---------------------------------------------------

Deno.test("esPeticionDeEnvioFacturas: reconoce preguntas sobre cómo enviar", () => {
  const frases = [
    "dónde envío mis facturas",
    "donde envio las facturas",
    "cómo registro una factura",
    "como mando un xml",
    "subo una factura",
    "mando un documento",
    "dónde mando mis facturas",
  ];
  for (const frase of frases) {
    assert(esPeticionDeEnvioFacturas(frase), `no reconoció: ${frase}`);
  }
});

Deno.test("esPeticionDeEnvioFacturas: NO intercepta consultas fiscales", () => {
  const frases = [
    "cuánto llevo en médicos",
    "mis facturas de julio",
    "dónde está mi factura del mes pasado",
    "dónde puedo ver mis deducciones",
  ];
  for (const frase of frases) {
    assertEquals(esPeticionDeEnvioFacturas(frase), false, `interceptó de más: ${frase}`);
  }
});

Deno.test("mensajeFormasEnvio: incluye email, WhatsApp y web como formas", () => {
  const m = mensajeFormasEnvio("facturas@x.com", "https://x.com");
  assert(m.includes("facturas@x.com"));
  assert(m.includes("WhatsApp"));
  assert(m.includes("https://x.com"));
});

