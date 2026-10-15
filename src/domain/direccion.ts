/**
 * Dirección de residencia estandarizada (nomenclatura urbana de Colombia). El portal la arma por partes y siempre
 * queda igual, por ejemplo «Carrera 54 B Bis Sur # 72 A - 30 Este, Apto 301»; el servidor exige el mismo formato para
 * que no se guarden direcciones escritas de cualquier forma.
 */
export const TIPOS_VIA = [
  'Calle',
  'Carrera',
  'Avenida',
  'Avenida Calle',
  'Avenida Carrera',
  'Diagonal',
  'Transversal',
  'Circular',
  'Circunvalar',
  'Vía',
  'Autopista',
] as const;

const ORIENTACION = String.raw`(?: (?:Norte|Sur|Este|Oeste))?`;
const NUMERO = String.raw`[1-9]\d{0,2}`;
const COMPLEMENTO = String.raw`(?:, [A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9][A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 .#\-]{0,59})?`;

export const PATRON_DIRECCION = new RegExp(
  `^(?:${TIPOS_VIA.join('|')}) ${NUMERO}(?: [A-Z])?(?: Bis)?${ORIENTACION}` +
    ` # ${NUMERO}(?: [A-Z])? - ${NUMERO}${ORIENTACION}${COMPLEMENTO}$`,
);

export const MENSAJE_DIRECCION =
  'Dirección: use el formato estándar del formulario, por ejemplo «Calle 72 # 54 - 30»';

export const esDireccionEstandar = (texto: string): boolean => PATRON_DIRECCION.test(texto);
