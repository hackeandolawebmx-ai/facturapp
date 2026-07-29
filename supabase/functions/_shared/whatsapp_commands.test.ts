import { assert, assertEquals } from "jsr:@std/assert@1";
import { interceptQuickCommand } from "./whatsapp_commands.ts";

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
