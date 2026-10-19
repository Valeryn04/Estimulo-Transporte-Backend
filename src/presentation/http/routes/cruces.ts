import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { requierePermisos } from '../middlewares/auth.js';
import { archivoDe, enviarArchivo, recibirArchivo } from '../subida.js';
import { contexto, idParam } from '../utilidades.js';

const texto = (campo: string, min: number, max: number) =>
  z
    .string({ error: `${campo}: escríbalo` })
    .trim()
    .min(min, `${campo}: escriba al menos ${min} caracteres`)
    .max(max, `${campo}: máximo ${max} caracteres`);

const estructuraSchema = z.object({
  nombre: texto('Nombre', 3, 100),
  entidad: z.string().trim().max(150, 'Entidad: máximo 150 caracteres').default(''),
  descripcion: z.string().trim().max(500, 'Descripción: máximo 500 caracteres').default(''),
  columnaIdentificacion: texto('Columna de identificación', 2, 60),
  columnaDetalle: z
    .string()
    .trim()
    .max(60, 'Columna de detalle: máximo 60 caracteres')
    .nullable()
    .default(null)
    .transform((v) => (v === '' ? null : v)),
  aplicaA: z.enum(['PCD', 'CUIDADOR', 'AMBOS'], { error: 'Aplica a: elija una opción' }),
});

/** Archivos de cruce (RF-ADM-05). Se monta bajo /admin/cruces. */
export function rutasCruces(s: Servicios): Router {
  const r = Router();
  const admin = requierePermisos('cruces.administrar');

  r.get('/', admin, async (_req, res) => {
    res.json({ items: await s.cruces.listar() });
  });

  r.post('/', admin, async (req, res) => {
    const d = estructuraSchema.parse(req.body);
    res.status(201).json(await s.cruces.crear(req.actor!, d, contexto(req)));
  });

  r.put('/:id', admin, async (req, res) => {
    const d = estructuraSchema.parse(req.body);
    res.json(await s.cruces.actualizar(req.actor!, idParam(req), d, contexto(req)));
  });

  r.post('/:id/activar', admin, async (req, res) => {
    res.json(await s.cruces.cambiarActivo(req.actor!, idParam(req), true, contexto(req)));
  });

  r.post('/:id/desactivar', admin, async (req, res) => {
    res.json(await s.cruces.cambiarActivo(req.actor!, idParam(req), false, contexto(req)));
  });

  r.get('/:id/versiones', admin, async (req, res) => {
    res.json({ items: await s.cruces.versiones(idParam(req)) });
  });

  r.get('/:id/cargas', admin, async (req, res) => {
    res.json({ items: await s.cruces.cargas(idParam(req)) });
  });

  r.post('/:id/cargas', admin, recibirArchivo, async (req, res) => {
    res
      .status(201)
      .json(await s.cruces.cargar(req.actor!, idParam(req), archivoDe(req), contexto(req)));
  });

  r.get('/cargas/:cargaId/errores', admin, async (req, res) => {
    const { nombre, contenido } = await s.cruces.reporteErrores(idParam(req, 'cargaId'));
    enviarArchivo(res, { nombre, mime: 'text/csv; charset=utf-8', contenido });
  });

  return r;
}
