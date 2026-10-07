import argon2 from 'argon2';

/** Hash adaptativo con sal por contraseña (argon2id). Nunca se almacena texto plano (RNF-05). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verificarPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// Hash de una contraseña inexistente: se verifica contra él cuando el usuario no existe,
// para que el tiempo de respuesta no revele qué usuarios hay registrados.
let hashSenuelo: Promise<string> | undefined;
export async function verificarContraSenuelo(password: string): Promise<void> {
  hashSenuelo ??= hashPassword('contraseña-senuelo-no-valida');
  await verificarPassword(await hashSenuelo, password);
}
