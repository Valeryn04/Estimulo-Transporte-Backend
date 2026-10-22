/**
 * Opciones de cierre de un desplegable: «Ninguna/Ninguno» (la persona no tiene) y «N/A» (no aplica).
 * No van en todas las listas. Según el formulario de la propuesta:
 *  - Género y estado civil llevan solo «N/A»: «ninguno» no es una respuesta posible.
 *  - Etnia, escolaridad y ocupación llevan solo «Ninguna/Ninguno»: es una respuesta real, y «N/A» sería lo mismo
 *    con otro nombre (decisión de la Alcaldía: una u otra según la lista, nunca las dos).
 *  - Las demás listas (tipo de identificación, EPS, barrios, transporte, causales…) no llevan ninguna: la
 *    respuesta siempre es una de las opciones de la lista.
 * Cada opción tiene un código fijo, así no se repite con otro nombre («No aplica», «NA») y se muestra al final.
 */
export interface ReglaOpciones {
  /** Código de «Ninguna/Ninguno» en la lista, o null si la lista no la lleva. */
  ninguna: 'NINGUNA' | 'NINGUNO' | null;
  /** La lista lleva «N/A». */
  noAplica: boolean;
}

const SIN_OPCIONES: ReglaOpciones = { ninguna: null, noAplica: false };

const REGLAS: Record<string, ReglaOpciones> = {
  GENERO: { ninguna: null, noAplica: true },
  ESTADO_CIVIL: { ninguna: null, noAplica: true },
  ETNIA: { ninguna: 'NINGUNA', noAplica: false },
  ESCOLARIDAD: { ninguna: 'NINGUNA', noAplica: false },
  OCUPACION: { ninguna: 'NINGUNO', noAplica: false },
};

export const CODIGO_NO_APLICA = 'NA';
export const NOMBRE_NO_APLICA = 'N/A';

export const reglaDeLista = (catalogo: string): ReglaOpciones => REGLAS[catalogo] ?? SIN_OPCIONES;

/** Compara sin tildes, mayúsculas ni signos: «N/A», «n.a.» y «No aplica» son la misma opción. */
const simplificar = (t: string) =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

export type TipoOpcion = 'NINGUNA' | 'NO_APLICA';

/** ¿El nombre es «Ninguna/Ninguno» o «N/A» (con cualquier escritura)? */
export function tipoDeOpcion(nombre: string): TipoOpcion | null {
  const s = simplificar(nombre);
  if (s === 'ninguna' || s === 'ninguno') return 'NINGUNA';
  if (s === 'na' || s === 'noaplica') return 'NO_APLICA';
  return null;
}

/** El código es el de una opción de cierre (se identifican por código, no por nombre). */
export const esCodigoDeCierre = (codigo: string) =>
  codigo === 'NINGUNA' || codigo === 'NINGUNO' || codigo === CODIGO_NO_APLICA;

export interface OpcionDeCierre {
  nombre: string;
  codigo: string;
}

/**
 * Si el nombre es «Ninguna/Ninguno» o «N/A», devuelve su nombre y código oficiales; si la lista no lleva esa
 * opción devuelve el mensaje de error que debe ver quien la agrega; si es un nombre común devuelve null.
 */
export function resolverOpcionDeCierre(
  catalogo: string,
  nombre: string,
): { opcion: OpcionDeCierre } | { error: string } | null {
  const tipo = tipoDeOpcion(nombre);
  if (!tipo) return null;
  const regla = reglaDeLista(catalogo);
  if (tipo === 'NINGUNA') {
    if (!regla.ninguna) {
      return {
        error: 'Nombre: esta lista no lleva la opción «Ninguna»; elija una de las opciones',
      };
    }
    return {
      opcion: {
        codigo: regla.ninguna,
        nombre: regla.ninguna === 'NINGUNO' ? 'Ninguno' : 'Ninguna',
      },
    };
  }
  if (!regla.noAplica) {
    return { error: 'Nombre: esta lista no lleva la opción «N/A»; elija una de las opciones' };
  }
  return { opcion: { codigo: CODIGO_NO_APLICA, nombre: NOMBRE_NO_APLICA } };
}
