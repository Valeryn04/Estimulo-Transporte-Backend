import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { DECISIONES, RESULTADOS } from '../../../domain/validacion.js';
import { requierePermisos } from '../middlewares/auth.js';
import { contexto, idParam, paginacionSchema } from '../utilidades.js';
import { enviarArchivo } from '../subida.js';

const ESTADOS_BANDEJA = ['RADICADA', 'SUBSANADA', 'EN_REVISION', 'EN_SUBSANACION'] as const;

const bandejaSchema = paginacionSchema.extend({
  estado: z.enum(ESTADOS_BANDEJA).optional(),
  asignado: z
    .string()
    .regex(/^(mios|sin|\d+)$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
  vencidas: z.enum(['true', 'false']).optional(),
  orden: z.enum(['radicado', 'fecha', 'nombre', 'estado', 'dias']).default('fecha'),
  direccion: z.enum(['asc', 'desc']).default('asc'),
});

const asignarSchema = z.object({
  solicitudIds: z
    .array(z.number().int().positive(), { error: 'Casos: elija al menos un caso' })
    .min(1, 'Casos: elija al menos un caso')
    .max(200),
  validadorId: z.number().int().positive().nullable(),
});

const itemSchema = z.object({
  resultado: z.enum(RESULTADOS, {
    error: 'Resultado: elija cumple, no cumple, pendiente o no aplica',
  }),
  fuente: z.string().trim().max(200, 'Fuente consultada: máximo 200 caracteres').default(''),
  observacion: z.string().trim().max(1000, 'Observación: máximo 1000 caracteres').default(''),
  evidencia: z.string().trim().max(1000, 'Evidencia: máximo 1000 caracteres').default(''),
});

const decisionSchema = z.object({
  decision: z.enum(DECISIONES, {
    error: 'Decisión: elija aprobar, solicitar subsanación o rechazar',
  }),
  motivacion: z.string().trim().max(2000, 'Motivación: máximo 2000 caracteres').default(''),
});

/**
 * Validación de requisitos (RF-VAL-01, RF-VAL-02): bandeja, revisión del caso con la lista de chequeo y decisión.
 * Se monta bajo /admin, ya autenticado; cada acción exige su permiso también en la API (RF-SEG-02).
 */
export function rutasValidacion(s: Servicios): Router {
  const r = Router();
  const ver = requierePermisos('validacion.ver');
  const validar = requierePermisos('validacion.validar');
  const asignar = requierePermisos('validacion.asignar');

  r.get('/bandeja', ver, async (req, res) => {
    const f = bandejaSchema.parse(req.query);
    const asignado =
      f.asignado === undefined
        ? undefined
        : f.asignado === 'mios' || f.asignado === 'sin'
          ? f.asignado
          : Number(f.asignado);
    const { items, total, tiempoMaxDias } = await s.validacion.bandeja({
      estado: f.estado,
      asignado,
      q: f.q || undefined,
      soloVencidas: f.vencidas === 'true',
      orden: f.orden,
      direccion: f.direccion,
      actorId: req.actor!.id,
      limit: f.tamano,
      offset: (f.pagina - 1) * f.tamano,
    });
    res.json({ items, total, pagina: f.pagina, tamano: f.tamano, tiempoMaxDias });
  });

  /** Personas a quienes se puede asignar un caso. */
  r.get('/validadores', asignar, async (_req, res) => {
    res.json({ items: await s.validacion.validadores() });
  });

  r.post('/asignar', asignar, async (req, res) => {
    const d = asignarSchema.parse(req.body);
    res.json(await s.validacion.asignar(req.actor!, d.solicitudIds, d.validadorId, contexto(req)));
  });

  r.get('/casos/:id', ver, async (req, res) => {
    res.json(await s.validacion.caso(req.actor!, idParam(req)));
  });

  r.post('/casos/:id/tomar', validar, async (req, res) => {
    await s.validacion.tomar(req.actor!, idParam(req), contexto(req));
    res.json(await s.validacion.caso(req.actor!, idParam(req)));
  });

  r.post('/casos/:id/liberar', ver, async (req, res) => {
    await s.validacion.liberar(req.actor!, idParam(req), contexto(req));
    res.status(204).end();
  });

  r.put('/casos/:id/items/:itemId', validar, async (req, res) => {
    const d = itemSchema.parse(req.body);
    res.json(
      await s.validacion.registrarItem(
        req.actor!,
        idParam(req),
        idParam(req, 'itemId'),
        d,
        contexto(req),
      ),
    );
  });

  r.post('/casos/:id/decision', validar, async (req, res) => {
    const d = decisionSchema.parse(req.body);
    res.status(201).json(await s.validacion.decidir(req.actor!, idParam(req), d, contexto(req)));
  });

  /** El funcionario consulta un documento del caso (solo roles con acceso a datos sensibles). */
  r.get('/casos/:id/documentos/:documentoId/archivo', ver, async (req, res) => {
    enviarArchivo(
      res,
      await s.validacion.archivo(
        req.actor!,
        idParam(req),
        idParam(req, 'documentoId'),
        contexto(req),
      ),
    );
  });

  return r;
}
