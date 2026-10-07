/** Quita espacios, puntos y guiones y pasa a mayúsculas: «1.234.567-8» y «1234567 8» son el mismo número. */
export function normalizarNumero(numero: string): string {
  return numero.replace(/[\s.-]/g, '').toUpperCase();
}

/** Longitudes admitidas por tipo de documento. CE y PT admiten letras y números. */
const REGLAS: Record<string, { patron: RegExp; ayuda: string }> = {
  CC: { patron: /^\d{5,10}$/, ayuda: 'La cédula de ciudadanía tiene entre 5 y 10 dígitos' },
  TI: { patron: /^\d{6,11}$/, ayuda: 'La tarjeta de identidad tiene entre 6 y 11 dígitos' },
  RC: { patron: /^\d{6,11}$/, ayuda: 'El registro civil tiene entre 6 y 11 dígitos' },
};
const REGLA_GENERAL = {
  patron: /^[A-Z0-9]{4,20}$/,
  ayuda: 'Use entre 4 y 20 letras o números, sin espacios ni símbolos',
};

/** Devuelve el motivo si el número no es válido para el tipo de documento, o null si lo es. */
export function errorNumeroIdentificacion(
  tipoCodigo: string,
  numeroNormalizado: string,
): string | null {
  const regla = REGLAS[tipoCodigo] ?? REGLA_GENERAL;
  return regla.patron.test(numeroNormalizado) ? null : regla.ayuda;
}

/** «maria.lopez@correo.com» → «m***@correo.com»: confirma el destino sin revelar el correo completo. */
export function enmascararCorreo(correo: string): string {
  const [usuario = '', dominio = ''] = correo.split('@');
  return `${usuario.slice(0, 1)}${'*'.repeat(Math.max(3, Math.min(usuario.length - 1, 6)))}@${dominio}`;
}

/** Nombre sin espacios repetidos. */
export function normalizarNombre(nombre: string): string {
  return nombre.trim().replace(/\s+/g, ' ');
}
