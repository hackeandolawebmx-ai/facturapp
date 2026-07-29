import { assertEquals } from "@std/assert";
import { validateRfc } from "./rfc_validation.ts";

Deno.test("validateRfc: RFC válido se normaliza a mayúsculas", () => {
  assertEquals(validateRfc("daxx860715xx0"), "DAXX860715XX0");
});

Deno.test("validateRfc: RFC con espacios se recorta", () => {
  assertEquals(validateRfc("  DAXX860715XX0  "), "DAXX860715XX0");
});

Deno.test("validateRfc: longitud incorrecta es inválida", () => {
  assertEquals(validateRfc("DAXX860715XX"), null);
  assertEquals(validateRfc("DAXX860715XX00"), null);
});

Deno.test("validateRfc: formato incorrecto (letras donde van dígitos) es inválido", () => {
  assertEquals(validateRfc("DAXXABCDEFXX0"), null);
});

Deno.test("validateRfc: acepta Ñ y & como caracteres válidos en las primeras 4 posiciones", () => {
  assertEquals(validateRfc("ÑAXX860715XX0"), "ÑAXX860715XX0");
  assertEquals(validateRfc("&AXX860715XX0"), "&AXX860715XX0");
});
