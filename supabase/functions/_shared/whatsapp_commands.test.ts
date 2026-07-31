import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  esPeticionDeEnlaceWeb, interceptQuickCommand, mensajeEnlaceAlta, mensajeEnlaceLogin,
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
