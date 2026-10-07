import type { Request, Response } from 'express';
import multer from 'multer';
import { errorValidacion } from '../../application/esquemas.js';
import type { ArchivoEntrada } from '../../application/documentos.js';

/** Tope absoluto de lo que se acepta recibir (el tamaño permitido por documento es un parámetro y se valida después). */
const TOPE_BYTES = 26 * 1_048_576;

/** Recibe un solo archivo, en memoria, en el campo «archivo». */
export const recibirArchivo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TOPE_BYTES, files: 1, fields: 5, parts: 8 },
}).single('archivo');

/** El archivo recibido, o un error de validación que pide elegir uno. */
export function archivoDe(req: Request): ArchivoEntrada {
  if (!req.file) {
    throw errorValidacion([
      { campo: 'archivo', mensaje: 'Seleccione el archivo que desea cargar.' },
    ]);
  }
  return {
    contenido: req.file.buffer,
    // multer entrega el nombre en latin1: se recupera el UTF-8 original (tildes y eñes).
    nombre: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
  };
}

/** Entrega un archivo como descarga: nunca se muestra dentro de la página. */
export function enviarArchivo(
  res: Response,
  archivo: { nombre: string; mime: string; contenido: Buffer },
): void {
  const ascii = archivo.nombre.replace(/[^ -~]|["\\]/g, '_');
  res.setHeader('Content-Type', archivo.mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(archivo.nombre)}`,
  );
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(archivo.contenido);
}
