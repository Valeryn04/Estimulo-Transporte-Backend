import type { Request } from 'express';
import { z } from 'zod';
import type { ContextoPeticion } from '../../application/contexto.js';
import { badRequest } from '../../shared/errors.js';

export const contexto = (req: Request): ContextoPeticion => ({ ip: req.ip ?? null });

const idSchema = z.coerce.number().int().positive();

export function idParam(req: Request, nombre = 'id'): number {
  const r = idSchema.safeParse(req.params[nombre]);
  if (!r.success) throw badRequest('ID_INVALIDO', 'El identificador no es válido');
  return r.data;
}

export const paginacionSchema = z.object({
  pagina: z.coerce.number().int().min(1).default(1),
  tamano: z.coerce.number().int().min(1).max(100).default(25),
});
