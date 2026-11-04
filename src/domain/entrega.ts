/** Reglas de la entrega del medio de transporte y la activación del beneficio (RF-ASI-05, RF-ASI-06). */

export type RolBeneficiario = 'PCD' | 'CUIDADOR';
export type TipoReceptor = 'PCD' | 'CUIDADOR' | 'TERCERO';

export const PATRON_TARJETA = /^[A-Z0-9-]{4,30}$/;

/** Normaliza el identificador de la tarjeta: mayúsculas, sin espacios. */
export const normalizarTarjeta = (t: string): string => t.trim().toUpperCase().replace(/\s+/g, '');

/**
 * Revisa que el identificador tenga el formato de las tarjetas (parámetros): comienza con el prefijo y sigue con la
 * cantidad exacta de dígitos. Devuelve el mensaje del error, o null si está bien.
 */
export function errorFormatoTarjeta(id: string, prefijo: string, digitos: number): string | null {
  const ejemplo = `${prefijo}${'12345678901234567890'.slice(0, digitos || 8)}`;
  if (prefijo && !id.startsWith(prefijo)) {
    return `Identificador de la tarjeta: debe comenzar por ${prefijo} (por ejemplo ${ejemplo})`;
  }
  const resto = prefijo ? id.slice(prefijo.length) : id;
  if (digitos > 0 && !new RegExp(`^[0-9]{${digitos}}$`).test(resto)) {
    return `Identificador de la tarjeta: ${prefijo ? `después de ${prefijo} ` : ''}deben ir exactamente ${digitos} dígitos (por ejemplo ${ejemplo})`;
  }
  return null;
}

/** Solo se ven los últimos cuatro caracteres: «*******4821». */
export function enmascararTarjeta(id: string): string {
  const visibles = id.length > 4 ? 4 : 1;
  return `${'*'.repeat(id.length - visibles)}${id.slice(-visibles)}`;
}

/** Personas del beneficio a quienes todavía no se les entrega la tarjeta. */
export function rolesPendientes(
  personas: 1 | 2,
  entregados: readonly RolBeneficiario[],
): RolBeneficiario[] {
  const requeridos: RolBeneficiario[] = personas === 2 ? ['PCD', 'CUIDADOR'] : ['PCD'];
  return requeridos.filter((r) => !entregados.includes(r));
}

/**
 * Estado del beneficio tras registrar una entrega: sigue pendiente de entrega hasta que todas las personas tengan su
 * tarjeta; entonces queda activo o pendiente de activación, según el procedimiento con el operador de transporte.
 */
export function estadoTrasEntrega(
  pendientes: number,
  activacionInmediata: boolean,
): 'PENDIENTE_ENTREGA' | 'PENDIENTE_ACTIVACION' | 'ACTIVO' {
  if (pendientes > 0) return 'PENDIENTE_ENTREGA';
  return activacionInmediata ? 'ACTIVO' : 'PENDIENTE_ACTIVACION';
}
