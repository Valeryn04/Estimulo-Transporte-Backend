import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { requiereAlguno, requierePermisos } from '../middlewares/auth.js';
import { contexto, idParam } from '../utilidades.js';

const codigo = (campo: string) =>
  z
    .string({ error: `${campo}: escríbalo` })
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{1,60}$/, `${campo}: use letras, números y guion bajo (máximo 60)`);

const opcionSchema = z.object({
  codigo: codigo('Código de la opción'),
  etiqueta: z
    .string({ error: 'Etiqueta de la opción: escríbala' })
    .trim()
    .min(1, 'Etiqueta de la opción: escríbala')
    .max(100, 'Etiqueta de la opción: máximo 100 caracteres'),
  puntos: z
    .number({ error: 'Puntos: escriba un número' })
    .min(0, 'Puntos: no pueden ser negativos')
    .max(100, 'Puntos: máximo 100'),
});

const variableSchema = z.object({
  codigo: codigo('Código de la variable').refine(
    (c) => c.length >= 2,
    'Código de la variable: mínimo 2 caracteres',
  ),
  nombre: z
    .string({ error: 'Nombre de la variable: escríbalo' })
    .trim()
    .min(3, 'Nombre de la variable: escriba al menos 3 caracteres')
    .max(150, 'Nombre de la variable: máximo 150 caracteres'),
  descripcion: z.string().trim().max(500, 'Descripción: máximo 500 caracteres').default(''),
  origen: z.enum(['VALIDADOR', 'SUBSIDIOS'], { error: 'Origen: elija una opción' }),
  peso: z
    .number({ error: 'Peso: escriba un número' })
    .gt(0, 'Peso: debe ser mayor que cero')
    .max(100, 'Peso: máximo 100'),
  opciones: z.array(opcionSchema).max(30, 'Opciones: máximo 30 por variable'),
});

const definicionSchema = z.object({
  notas: z.string().trim().max(1000, 'Notas: máximo 1000 caracteres').default(''),
  desempate: z.array(z.string().trim().max(80)).max(10).default([]),
  variables: z.array(variableSchema).max(60),
});

const borradorSchema = z.object({
  desdeId: z.number().int().positive().optional(),
  definicion: definicionSchema.optional(),
});

const decisionSchema = z.object({
  decision: z.enum(['APROBAR', 'RECHAZAR'], { error: 'Decisión: elija aprobar o rechazar' }),
  motivo: z.string().trim().max(1000, 'Motivo: máximo 1000 caracteres').default(''),
});

/**
 * Matriz de ponderación versionada (RF-PRI-02). La configura el administrador y la aprueba el responsable del
 * proceso. Se monta bajo /admin/matriz.
 */
export function rutasMatriz(s: Servicios): Router {
  const r = Router();
  const ver = requiereAlguno('matriz.administrar', 'priorizacion.aprobar');
  const administrar = requierePermisos('matriz.administrar');
  const aprobar = requierePermisos('priorizacion.aprobar');

  r.get('/', ver, async (_req, res) => {
    res.json({ items: await s.matriz.listar() });
  });

  r.post('/', administrar, async (req, res) => {
    const d = borradorSchema.parse(req.body ?? {});
    res.status(201).json(await s.matriz.crearBorrador(req.actor!, d, contexto(req)));
  });

  r.get('/:id', ver, async (req, res) => {
    res.json(await s.matriz.obtener(idParam(req)));
  });

  r.put('/:id', administrar, async (req, res) => {
    const d = definicionSchema.parse(req.body);
    res.json(await s.matriz.actualizar(req.actor!, idParam(req), d, contexto(req)));
  });

  r.get('/:id/simulacion', ver, async (req, res) => {
    res.json(await s.matriz.simular(idParam(req)));
  });

  r.post('/:id/solicitar-aprobacion', administrar, async (req, res) => {
    res.json(await s.matriz.solicitarAprobacion(req.actor!, idParam(req), contexto(req)));
  });

  r.post('/:id/decision', aprobar, async (req, res) => {
    const d = decisionSchema.parse(req.body);
    res.json(await s.matriz.decidir(req.actor!, idParam(req), d, contexto(req)));
  });

  return r;
}
