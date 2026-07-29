import { assert, assertEquals } from "jsr:@std/assert@1";
import { hashPassword, verifyPassword } from "./passwords.ts";

Deno.test("hashPassword + verifyPassword: round-trip correcto", () => {
  const hash = hashPassword("MiClaveSegura123");
  assert(verifyPassword("MiClaveSegura123", hash));
});

Deno.test("verifyPassword: password incorrecta es rechazada", () => {
  const hash = hashPassword("MiClaveSegura123");
  assertEquals(verifyPassword("otra-clave", hash), false);
});

Deno.test("verifyPassword: hash real generado por Python bcrypt (interoperabilidad)", () => {
  // Generado con: bcrypt.hashpw(b"MiPasswordSegura123", bcrypt.gensalt())
  const pythonHash = "$2b$12$qph4/f7mkI3i41.Y.L9YwOo4L6ET0NHOvZnNv496wXGjc9X5GEtU.";
  assert(verifyPassword("MiPasswordSegura123", pythonHash));
  assertEquals(verifyPassword("password-incorrecta", pythonHash), false);
});

Deno.test("verifyPassword: hash corrupto/no-bcrypt no lanza, devuelve false", () => {
  assertEquals(verifyPassword("cualquier-cosa", "no-es-un-hash-bcrypt"), false);
});

Deno.test("hashPassword: contraseñas largas (>72 bytes) se truncan como en Python", () => {
  const larga = "a".repeat(100);
  const hash = hashPassword(larga);
  // Verificar con los primeros 72 bytes también debe pasar (mismo comportamiento
  // de truncamiento que bcrypt.hashpw en Python).
  assert(verifyPassword("a".repeat(72), hash));
});
