import type { Request } from 'express';
import { Router } from 'express';
import { z, type ZodType } from 'zod';
import type { Servicios } from '../../../container.js';
import { errorValidacion } from '../../../application/esquemas.js';
import { requierePermisos } from '../middlewares/auth.js';
import { archivoDe, enviarArchivo, recibirArchivo } from '../subida.js';
import { contexto, idParam, paginacionSchema } from '../utilidades.js';

/** Lee el campo «datos» (JSON) de una petición multipart y lo valida. */
function datosDe<T>(req: Request, esquema: ZodType<T>): T {
  let crudo: unknown;
  try {
    crudo = JSON.parse(String((req.body as Record<string, unknown>)?.datos ?? ''));
  } catch {
    throw errorValidacion([
      { campo: 'datos', mensaje: 'Datos: envíe la información en el campo «datos»' },
    ]);
  }
  const r = esquema.safeParse(crudo);
  if (!r.success) {
    throw errorValidacion(
      r.error.issues.map((i) => ({ campo: String(i.path[0] ?? 'datos'), mensaje: i.message })),
    );
  }
  return r.data;
}

const fecha = (campo: string) => z.iso.date({ error: `${campo}: use el formato AAAA-MM-DD` });

const novedadSchema = z.object({
  tipo: z.enum(['BLOQUEO', 'SUSPENSION', 'LEVANTAMIENTO'], { error: 'Tipo: elija una opción' }),
  causalId: z.number().int().positive().optional(),
  fechaEfectiva: fecha('Fecha efectiva'),
  observacion: z.string().trim().max(1000, 'Observación: máximo 1000 caracteres').default(''),
  levantamientoProgramado: fecha('Levantamiento programado').optional(),
});

const iniciarSchema = z.object({
  causalId: z
    .number({ error: 'Causal: elija una de la lista' })
    .int()
    .positive('Causal: elija una de la lista'),
  descripcion: z
    .string({ error: 'Descripción: escríbala' })
    .trim()
    .max(2000, 'Descripción: máximo 2000 caracteres'),
});

const trasladoSchema = z.object({
  texto: z
    .string({ error: 'Traslado: escríbalo' })
    .trim()
    .max(4000, 'Traslado: máximo 4000 caracteres'),
});

const descargosSchema = z.object({
  texto: z.string().trim().max(4000, 'Descargos: máximo 4000 caracteres').default(''),
  sinDescargos: z.boolean().default(false),
});

const decisionSchema = z.object({
  resultado: z.enum(['REVOCAR', 'ARCHIVAR'], { error: 'Decisión: elija revocar o archivar' }),
  motivacion: z
    .string({ error: 'Motivación: escríbala' })
    .trim()
    .max(4000, 'Motivación: máximo 4000 caracteres'),
  numeroActo: z
    .string({ error: 'Número del acto: escríbalo' })
    .trim()
    .max(100, 'Número del acto: máximo 100 caracteres'),
});

const analisisSchema = z.object({
  accion: z.enum(['DESCARTAR', 'INICIAR_REVOCATORIA'], { error: 'Acción: elija una opción' }),
  observacion: z
    .string({ error: 'Observación: escríbala' })
    .trim()
    .max(1000, 'Observación: máximo 1000 caracteres'),
});

const resumenSchema = paginacionSchema.extend({
  estado: z
    .enum([
      'PENDIENTE_ENTREGA',
      'PENDIENTE_ACTIVACION',
      'ACTIVO',
      'BLOQUEADO',
      'SUSPENDIDO',
      'FINALIZADO',
    ])
    .optional(),
  q: z.string().trim().max(100).optional(),
});

const revocatoriasSchema = paginacionSchema.extend({
  estado: z.enum(['INICIADA', 'EN_TRASLADO', 'CON_DESCARGOS', 'DECIDIDA']).optional(),
});

const alertasSchema = paginacionSchema.extend({
  estado: z.enum(['PENDIENTE', 'DESCARTADA', 'EN_TRAMITE']).optional(),
});

/**
 * Novedades del beneficio (RF-NOV-01), revocatoria con debido proceso (RF-NOV-02) y alertas de cruce (RF-NOV-03). Se
 * monta bajo /admin/novedades.
 */
export function rutasNovedades(s: Servicios): Router {
  const r = Router();
  const ver = requierePermisos('novedades.ver');
  const gestionar = requierePermisos('novedades.gestionar');

  r.get('/resumen', ver, async (req, res) => {
    const f = resumenSchema.parse(req.query);
    res.json(
      await s.novedades.resumen({
        estado: f.estado,
        q: f.q || undefined,
        limit: f.tamano,
        offset: (f.pagina - 1) * f.tamano,
      }),
    );
  });

  r.get('/causales', ver, async (_req, res) => {
    res.json(await s.novedades.causales());
  });

  r.get('/beneficios/:id', ver, async (req, res) => {
    res.json(await s.novedades.beneficio(idParam(req)));
  });

  /** Bloquear, suspender o reactivar: multipart con `datos` y la evidencia en `archivo`. */
  r.post('/beneficios/:id/novedades', gestionar, recibirArchivo, async (req, res) => {
    const d = datosDe(req, novedadSchema);
    res
      .status(201)
      .json(
        await s.novedades.registrarNovedad(
          req.actor!,
          idParam(req),
          d,
          archivoDe(req),
          contexto(req),
        ),
      );
  });

  r.get('/novedades/:id/evidencia', ver, async (req, res) => {
    enviarArchivo(res, await s.novedades.evidenciaDeNovedad(idParam(req)));
  });

  r.post('/beneficios/:id/revocatorias', gestionar, recibirArchivo, async (req, res) => {
    const d = datosDe(req, iniciarSchema);
    const id = await s.novedades.iniciarRevocatoria(
      req.actor!,
      idParam(req),
      d,
      archivoDe(req),
      contexto(req),
    );
    res.status(201).json(await s.novedades.revocatoria(id));
  });

  r.get('/revocatorias', ver, async (req, res) => {
    const f = revocatoriasSchema.parse(req.query);
    res.json(
      await s.novedades.listarRevocatorias({
        estado: f.estado,
        limit: f.tamano,
        offset: (f.pagina - 1) * f.tamano,
      }),
    );
  });

  r.get('/revocatorias/:id', ver, async (req, res) => {
    res.json(await s.novedades.revocatoria(idParam(req)));
  });

  r.post('/revocatorias/:id/traslado', gestionar, recibirArchivo, async (req, res) => {
    const d = datosDe(req, trasladoSchema);
    res.json(
      await s.novedades.registrarTraslado(
        req.actor!,
        idParam(req),
        d,
        req.file ? archivoDe(req) : null,
        contexto(req),
      ),
    );
  });

  r.post('/revocatorias/:id/descargos', gestionar, recibirArchivo, async (req, res) => {
    const d = datosDe(req, descargosSchema);
    res.json(
      await s.novedades.registrarDescargos(
        req.actor!,
        idParam(req),
        d,
        req.file ? archivoDe(req) : null,
        contexto(req),
      ),
    );
  });

  r.post('/revocatorias/:id/decision', gestionar, recibirArchivo, async (req, res) => {
    const d = datosDe(req, decisionSchema);
    res.json(
      await s.novedades.decidirRevocatoria(
        req.actor!,
        idParam(req),
        d,
        archivoDe(req),
        contexto(req),
      ),
    );
  });

  r.get('/revocatorias/eventos/:id/evidencia', ver, async (req, res) => {
    enviarArchivo(res, await s.novedades.evidenciaDeEvento(idParam(req)));
  });

  r.get('/alertas-cruce', ver, async (req, res) => {
    const f = alertasSchema.parse(req.query);
    res.json(
      await s.novedades.alertasCruce({
        estado: f.estado,
        limit: f.tamano,
        offset: (f.pagina - 1) * f.tamano,
      }),
    );
  });

  r.post('/alertas-cruce/:id/analizar', gestionar, recibirArchivo, async (req, res) => {
    const d = datosDe(req, analisisSchema);
    res.json(
      await s.novedades.analizarAlerta(
        req.actor!,
        idParam(req),
        d,
        req.file ? archivoDe(req) : null,
        contexto(req),
      ),
    );
  });

  return r;
}
