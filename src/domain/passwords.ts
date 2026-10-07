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
