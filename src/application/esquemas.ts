import { unprocessable } from '../shared/errors.js';

export interface ErrorCampo {
  campo: string;
  mensaje: string;
}

/** Error 422 con la lista de campos a corregir (mismo formato que produce zod). */
export function errorValidacion(errores: ErrorCampo[]) {
  return unprocessable('VALIDACION', 'Revise los datos ingresados', { errores });
}
