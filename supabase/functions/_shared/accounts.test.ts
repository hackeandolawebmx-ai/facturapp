import { assertEquals } from "@std/assert";
import { placeholderRfc } from "./accounts.ts";

Deno.test("placeholderRfc: determinístico y de 13 caracteres, empieza con PEND", () => {
  const rfc = placeholderRfc("5215512345678");
  assertEquals(rfc.length, 13);
  assertEquals(rfc.startsWith("PEND"), true);
  assertEquals(rfc, placeholderRfc("5215512345678")); // mismo seed → mismo RFC
});

Deno.test("placeholderRfc: coincide con la salida real de Python (mismo seed)", () => {
  // Valor verificado cruzando contra hashlib.sha256 real de Python para el
  // mismo seed "5215512345678" (ver conversación de Fase M4).
  assertEquals(placeholderRfc("5215512345678"), "PEND8A3B94BF7");
});

Deno.test("placeholderRfc: seeds distintos producen RFCs distintos", () => {
  const a = placeholderRfc("5215512345678");
  const b = placeholderRfc("5215512345679");
  assertEquals(a === b, false);
});
