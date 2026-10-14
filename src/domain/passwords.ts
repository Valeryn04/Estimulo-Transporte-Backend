import { randomInt } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 10;

/** Política de contraseña segura de los usuarios internos (RNF-05). */
export function validarPassword(password: string, usuario?: string): string[] {
  const errores: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH) {
    errores.push(`Debe tener al menos ${PASSWORD_MIN_LENGTH} caracteres`);
  }
  if (password.length > 128) errores.push('No puede superar 128 caracteres');
  if (!/[a-z]/.test(password)) errores.push('Debe incluir una letra minúscula');
  if (!/[A-Z]/.test(password)) errores.push('Debe incluir una letra mayúscula');
  if (!/[0-9]/.test(password)) errores.push('Debe incluir un número');
  if (!/[^A-Za-z0-9]/.test(password)) errores.push('Debe incluir un símbolo (por ejemplo ! # $ %)');
  if (usuario && usuario.length >= 3 && password.toLowerCase().includes(usuario.toLowerCase())) {
    errores.push('No puede contener el nombre de usuario');
  }
  return errores;
}

// Sin caracteres que se confunden al leerlos (0/O, 1/l/I): la persona la copia del correo.
const MAYUSCULAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const MINUSCULAS = 'abcdefghijkmnpqrstuvwxyz';
const NUMEROS = '23456789';
const SIMBOLOS = '!#$%&*+-=?@';
const TODOS = MAYUSCULAS + MINUSCULAS + NUMEROS + SIMBOLOS;

const uno = (caracteres: string) => caracteres[randomInt(caracteres.length)] as string;

/**
 * Contraseña temporal que genera el sistema (el administrador nunca la ve ni la escribe): cumple la política de
 * contraseñas, usa un generador criptográfico y no contiene el nombre de usuario. La persona debe cambiarla al
 * ingresar por primera vez.
 */
export function generarPasswordTemporal(usuario?: string, longitud = 14): string {
  for (;;) {
    const letras = [uno(MAYUSCULAS), uno(MINUSCULAS), uno(NUMEROS), uno(SIMBOLOS)];
    while (letras.length < longitud) letras.push(uno(TODOS));
    // Baraja (Fisher-Yates) para que las clases obligatorias no queden siempre al inicio.
    for (let i = letras.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [letras[i], letras[j]] = [letras[j] as string, letras[i] as string];
    }
    const candidata = letras.join('');
    if (validarPassword(candidata, usuario).length === 0) return candidata;
  }
}
