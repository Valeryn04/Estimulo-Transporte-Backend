import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { AppError } from '../../../shared/errors.js';
import { logger } from '../../../shared/logger.js';

/** Formato único de error: { error: { codigo, mensaje, errores?, detalle? } }. */
export function cuerpoError(codigo: string, mensaje: string, extra: Record<string, unknown> = {}) {
  return { error: { codigo, mensaje, ...extra } };
}

export const rutaNoEncontrada: RequestHandler = (req, res) => {
  res
    .status(404)
    .json(cuerpoError('RUTA_NO_ENCONTRADA', `La ruta ${req.method} ${req.path} no existe`));
};

export const manejadorErrores: ErrorRequestHandler = (error: unknown, req, res, _next) => {
  if (res.headersSent) return;

  if (error instanceof ZodError) {
    const errores = error.issues.map((i) => ({
      campo: i.path.join('.'),
      mensaje: i.message,
    }));
    res.status(422).json(cuerpoError('VALIDACION', 'Revise los datos ingresados', { errores }));
    return;
  }

  if (error instanceof AppError) {
    const detalle = error.details as { errores?: unknown } | undefined;
    if (detalle && typeof detalle === 'object' && 'errores' in detalle) {
      res
        .status(error.status)
        .json(cuerpoError(error.code, error.message, { errores: detalle.errores }));
    } else {
      res
        .status(error.status)
        .json(
          cuerpoError(error.code, error.message, error.details ? { detalle: error.details } : {}),
        );
    }
    return;
  }

  if (error instanceof multer.MulterError) {
    const mensaje =
      error.code === 'LIMIT_FILE_SIZE'
        ? 'Uno de los archivos supera el tamaño máximo permitido'
        : error.code === 'LIMIT_UNEXPECTED_FILE'
          ? 'Se recibió un archivo que no corresponde al formulario'
          : 'No fue posible leer los archivos enviados';
    res.status(422).json(cuerpoError('ARCHIVO_INVALIDO', mensaje));
    return;
  }

  if ((error as { type?: string }).type === 'entity.parse.failed') {
    res
      .status(400)
      .json(cuerpoError('JSON_INVALIDO', 'El cuerpo de la petición no es un JSON válido'));
    return;
  }
  if ((error as { type?: string }).type === 'entity.too.large') {
    res.status(413).json(cuerpoError('CUERPO_MUY_GRANDE', 'La petición es demasiado grande'));
    return;
  }

  logger.error({ error, ruta: `${req.method} ${req.originalUrl}` }, 'Error no controlado');
  res
    .status(500)
    .json(cuerpoError('ERROR_INTERNO', 'Ocurrió un error inesperado. Intente de nuevo más tarde.'));
};
