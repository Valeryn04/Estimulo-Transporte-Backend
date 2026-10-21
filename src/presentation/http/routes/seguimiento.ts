import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { REPORTES } from '../../../infrastructure/repositories/reportes.js';
import { requiereAlguno, requierePermisos } from '../middlewares/auth.js';
import { contexto, idParam } from '../utilidades.js';

const fecha = (campo: string) => z.iso.date({ error: `${campo}: use el formato AAAA-MM-DD` });
const entero = z.coerce.number().int().positive();

const bitacoraSchema = z.object({
  radicado: z.string().trim().max(30).optional(),
  usuario: z.string().trim().max(50).optional(),
  modulo: z.string().trim().max(40).optional(),
  accion: z.string().trim().max(60).optional(),
  desde: fecha('Desde').optional(),
  hasta: fecha('Hasta').optional(),
  pagina: z.coerce.number().int().min(1).default(1),
  tamano: z.coerce.number().int().min(1).max(100).default(50),
});

const tableroSchema = z.object({
  vigenciaId: entero.optional(),
  localidadId: entero.optional(),
  poblacion: z.enum(['CON_CUIDADOR', 'SIN_CUIDADOR']).optional(),
  etapa: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
});

const reporteSchema = z.object({
  vigenciaId: entero.optional(),
  desde: fecha('Desde').optional(),
  hasta: fecha('Hasta').optional(),
  localidadId: entero.optional(),
  estado: z.string().trim().max(30).optional(),
  poblacion: z.enum(['CON_CUIDADOR', 'SIN_CUIDADOR']).optional(),
});

const codigos = REPORTES.map((r) => r.codigo) as [string, ...string[]];
const codigoSchema = z.enum(codigos, { error: 'Reporte desconocido' });

const biSchema = z.object({
  desde: fecha('Desde').optional(),
  hasta: fecha('Hasta').optional(),
  despuesDe: entero.optional(),
  limite: z.coerce.number().int().min(1).max(5000).default(1000),
  formato: z.enum(['json', 'csv']).default('json'),
});

/** Seguimiento del programa: bitácora, expediente, tablero, reportes y BI. Se monta bajo /admin. */
export function rutasSeguimiento(s: Servicios): Router {
  const r = Router();

  r.get(
    '/seguimiento/filtros',
    requiereAlguno('bitacora.ver', 'tablero.ver', 'reportes.ver'),
    async (_req, res) => {
      res.json(await s.seguimiento.filtros());
    },
  );

  r.get('/bitacora', requierePermisos('bitacora.ver'), async (req, res) => {
    const q = bitacoraSchema.parse(req.query);
    const { pagina, tamano, ...filtros } = q;
    res.json({
      pagina,
      tamano,
      ...(await s.seguimiento.bitacora(
        req.actor!,
        { ...filtros, limit: tamano, offset: (pagina - 1) * tamano },
        contexto(req),
      )),
    });
  });

  r.get('/bitacora/modulos', requierePermisos('bitacora.ver'), async (_req, res) => {
    res.json({ items: await s.seguimiento.modulosBitacora() });
  });

  r.get('/expedientes', requierePermisos('expediente.ver'), async (req, res) => {
    const q = z.object({ q: z.string().trim().min(3, 'Escriba al menos 3 caracteres').max(100) }).parse(req.query);
    res.json({ items: await s.seguimiento.buscarExpedientes(q.q) });
  });

  r.get('/expedientes/:solicitudId', requierePermisos('expediente.ver'), async (req, res) => {
    res.json(await s.seguimiento.expediente(req.actor!, idParam(req, 'solicitudId'), contexto(req)));
  });

  r.get('/tablero', requierePermisos('tablero.ver'), async (req, res) => {
    res.json(await s.seguimiento.tablero(tableroSchema.parse(req.query)));
  });

  r.get('/reportes', requierePermisos('reportes.ver'), (_req, res) => {
    res.json({ items: s.seguimiento.catalogoReportes() });
  });

  r.get('/reportes/exportaciones', requierePermisos('reportes.exportar'), async (_req, res) => {
    res.json(await s.seguimiento.exportaciones());
  });

  r.get('/reportes/:codigo', requierePermisos('reportes.ver'), async (req, res) => {
    const codigo = codigoSchema.parse(req.params.codigo);
    res.json(await s.seguimiento.vistaPrevia(req.actor!, codigo as never, reporteSchema.parse(req.query)));
  });

  r.get('/reportes/:codigo/exportar', requierePermisos('reportes.exportar'), async (req, res) => {
    const codigo = codigoSchema.parse(req.params.codigo);
    const { formato } = z.object({ formato: z.enum(['XLSX', 'PDF'], { error: 'Formato: XLSX o PDF' }) }).parse(req.query);
    const filtros = reporteSchema.parse(req.query);
    const a = await s.seguimiento.exportar(req.actor!, codigo as never, formato, filtros, contexto(req));
    res
      .type(a.tipo)
      .set('Content-Disposition', `attachment; filename="${a.nombre}"`)
      .set('Cache-Control', 'no-store')
      .send(a.archivo);
  });

  r.get('/bi/eventos', requierePermisos('bi.consultar'), async (req, res) => {
    const { formato, ...f } = biSchema.parse(req.query);
    if (formato === 'csv') {
      const csv = await s.seguimiento.eventosBiCsv(req.actor!, f, contexto(req));
      res.type('text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="eventos-bi.csv"').send(csv);
      return;
    }
    res.json(await s.seguimiento.eventosBi(req.actor!, f, contexto(req)));
  });

  return r;
}
