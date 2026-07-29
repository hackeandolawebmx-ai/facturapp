/**
 * Hashing de contraseñas (Fase M7) — port 1:1 de auth.py (hash_password/
 * verify_password).
 *
 * Usa `bcryptjs` (JS puro) en vez del `bcrypt` de Python (bindings nativos
 * en C) — verificado con interoperabilidad real: un hash generado por
 * `bcrypt.hashpw()` en Python fue verificado exitosamente por
 * `bcryptjs.compareSync()` en Deno, y viceversa (mismo algoritmo bcrypt
 * estándar, compatible en ambos sentidos — no es una reimplementación
 * distinta, es el mismo formato `$2a$`/`$2b$`).
 *
 * bcrypt trunca la contraseña a 72 bytes — igual que en Python, se hace
 * explícito aquí para evitar comportamiento sorpresa de la librería.
 */
import bcrypt from "npm:bcryptjs@2";

const BCRYPT_MAX_BYTES = 72;
const BCRYPT_ROUNDS = 12;

function truncateToBcryptLimit(password: string): string {
  const bytes = new TextEncoder().encode(password);
  if (bytes.length <= BCRYPT_MAX_BYTES) return password;
  return new TextDecoder().decode(bytes.slice(0, BCRYPT_MAX_BYTES));
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(truncateToBcryptLimit(password), BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hashed: string): boolean {
  try {
    return bcrypt.compareSync(truncateToBcryptLimit(plain), hashed);
  } catch {
    return false;
  }
}
