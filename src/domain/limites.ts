/**
 * Límites que NO dependen de un parámetro: protegen al sistema aunque alguien cambie un valor configurable.
 * Un parámetro puede ajustar su valor solo dentro de su rango (que se define en la base de datos y se muestra al
 * administrador), y estos topes quedan por encima de todo.
 */

/** Tamaño máximo por documento que se puede llegar a permitir, aunque el parámetro diga otra cosa. */
export const ARCHIVO_MAX_MB_ABSOLUTO = 10;

/**
 * Permisos que solo tiene el administrador y no se pueden asignar a otro rol: lo que ellos cambian (parámetros de
 * seguridad, tamaños, vigencias y cupos) afecta a todo el sistema.
 */
export const PERMISOS_SOLO_ADMINISTRADOR: readonly string[] = ['parametros.administrar'];
