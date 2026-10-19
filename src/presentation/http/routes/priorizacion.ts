import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { errorValidacion } from '../../../application/esquemas.js';
import { requierePermisos } from '../middlewares/auth.js';
import { archivoDe, enviarArchivo, recibirArchivo } from '../subida.js';
import { contexto, idParam, paginacionSchema } from '../utilidades.js';

const listadoSchema = paginacionSchema.extend({
  vigenciaId: z.coerce.number().int().positive().optional(),
  localidadId: z.coerce.number().int().positive().optional(),
  transporteId: z.coerce.number().int().positive().optional(),
  poblacion: z.enum(['CON_CUIDADOR', 'SIN_CUIDADOR']).optional(),
  q: z.string().trim().max(100).optional(),
});

const masivoSchema = z.object({ recalcular: z.boolean().default(false) });

const proponerSchema = z.object({
  ajuste: z.coerce
    .number({ error: 'Ajuste: escriba un número, por ejemplo 10 o -5' })
    .min(-100, 'Ajuste: entre -100 y 100')
    .max(100, 'Ajuste: entre -100 y 100')
    .refine((n) => n !== 0, 'Ajuste: no puede ser cero'),
  justificacion: z
    .string({ error: 'Justificación: escríbala' })
    .trim()
    .min(20, 'Justificación: explique el caso con al menos 20 caracteres')
    .max(2000, 'Justificación: máximo 2000 caracteres'),
});

const decisionSchema = z.object({
  decision: z.enum(['APROBAR', 'RECHAZAR'], { error: 'Decisión: elija aprobar o rechazar' }),
  motivo: z.string().trim().max(1000, 'Motivo: máximo 1000 caracteres').default(''),
});

const excepcionesSchema = paginacionSchema.extend({
  estado: z.enum(['PROPUESTA', 'APROBADA', 'RECHAZADA']).optional(),
});

/**
 * Priorización (RF-PRI-01, RF-PRI-03, RF-PRI-04): puntaje de los casos validados, listado priorizado y excepciones.
 * Se monta bajo /admin/priorizacion.
 */
export function rutasPriorizacion(s: Servicios): Router {
  const r = Router();
  const ver = requierePermisos('priorizacion.ver');
  const calcular = requierePermisos('priorizacion.calcular');
  const proponer = requierePermisos('priorizacion.proponer');
  const aprobar = requierePermisos('priorizacion.aprobar');

  r.get('/filtros', ver, async (_req, res) => {
    res.json(await s.priorizacion.filtros());
  });

  r.get('/listado', ver, async (req, res) => {
    const f = listadoSchema.parse(req.query);
    res.json(
      await s.priorizacion.listado({
        vigenciaId: f.vigenciaId,
        localidadId: f.localidadId,
        transporteId: f.transporteId,
        poblacion: f.poblacion,
        q: f.q || undefined,
        limit: f.tamano,
        offset: (f.pagina - 1) * f.tamano,
      }),
    );
  });

  r.post('/calcular', calcular, async (req, res) => {
    const d = masivoSchema.parse(req.body ?? {});
    res.json(await s.priorizacion.calcularMasivo(req.actor!, d, contexto(req)));
  });

  r.get('/casos/:id', ver, async (req, res) => {
    res.json(await s.priorizacion.caso(idParam(req)));
  });

  r.post('/casos/:id/calcular', calcular, async (req, res) => {
    res.json(await s.priorizacion.calcularCaso(req.actor!, idParam(req), contexto(req)));
  });

  r.post('/casos/:id/excepciones', proponer, recibirArchivo, async (req, res) => {
    const parsed = proponerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw errorValidacion(
        parsed.error.issues.map((i) => ({ campo: String(i.path[0] ?? ''), mensaje: i.message })),
      );
    }
    const archivo = archivoDe(req);
    res
      .status(201)
      .json(
        await s.priorizacion.proponerExcepcion(
          req.actor!,
          idParam(req),
          parsed.data,
          archivo,
          contexto(req),
        ),
      );
  });

  r.get('/excepciones', ver, async (req, res) => {
    const f = excepcionesSchema.parse(req.query);
    res.json(
      await s.priorizacion.listarExcepciones({
        estado: f.estado,
        limit: f.tamano,
        offset: (f.pagina - 1) * f.tamano,
      }),
    );
  });

  r.post('/excepciones/:id/decision', aprobar, async (req, res) => {
    const d = decisionSchema.parse(req.body);
    res.json(await s.priorizacion.decidirExcepcion(req.actor!, idParam(req), d, contexto(req)));
  });

  r.get('/excepciones/:id/evidencia', ver, async (req, res) => {
    enviarArchivo(res, await s.priorizacion.evidencia(idParam(req)));
  });

  return r;
}
