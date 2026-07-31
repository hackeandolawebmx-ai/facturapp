import { assertEquals } from "jsr:@std/assert@1";
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

// ---- Persona moral, 12 caracteres (Fase M14) --------------------------------
//
// Detectado con un RFC de empresa real: DJB850527F30 (12 caracteres) fue
// rechazado porque el validador solo conocía el formato de persona física
// (13). Una moral lleva 3 letras, no 4 — sin la inicial del apellido
// materno que sí llevan las físicas.

Deno.test("validateRfc: por defecto sigue exigiendo 13 (persona física) — compatibilidad", () => {
  // auth-register y el perfil no pasan `tipo`; no deben empezar a aceptar
  // RFCs de 12 caracteres como identidad personal del dueño de la cuenta.
  assertEquals(validateRfc("DJB850527F30"), null);
});

Deno.test("validateRfc: con tipo 'moral' acepta 12 caracteres", () => {
  assertEquals(validateRfc("DJB850527F30", "moral"), "DJB850527F30");
});

Deno.test("validateRfc: moral normaliza a mayúsculas y recorta espacios", () => {
  assertEquals(validateRfc("  djb850527f30  ", "moral"), "DJB850527F30");
});

Deno.test("validateRfc: un RFC de 13 caracteres NO es válido como moral", () => {
  // Si alguien elige "moral" por error con su propio RFC personal, no debe
  // colarse — el tipo decide una longitud exacta, no un rango.
  assertEquals(validateRfc("DAXX860715XX0", "moral"), null);
});

Deno.test("validateRfc: un RFC de 12 caracteres NO es válido como física", () => {
  assertEquals(validateRfc("DJB850527F30", "fisica"), null);
});

Deno.test("validateRfc: formato moral incorrecto (dígito donde va letra) es inválido", () => {
  assertEquals(validateRfc("1JB850527F30", "moral"), null);
});
