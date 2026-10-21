import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { requiereAlguno, requierePermisos } from '../middlewares/auth.js';
import { contexto, idParam } from '../utilidades.js';

const preguntaSchema = z.object({
  tipo: z.enum(['SELECCION', 'ESCALA', 'TEXTO'], { error: 'Tipo de pregunta: elija una opción' }),
  texto: z
    .string({ error: 'Pregunta: escríbala' })
    .trim()
    .min(5, 'Pregunta: escriba al menos 5 caracteres')
    .max(300, 'Pregunta: máximo 300 caracteres'),
  obligatoria: z.boolean().default(true),
  opciones: z
    .array(z.string().trim().max(100, 'Opción: máximo 100 caracteres'))
    .max(12)
    .nullable()
    .default(null),
  escalaMax: z.number().int().min(3).max(10).nullable().default(null),
});

const encuestaSchema = z.object({
  titulo: z
    .string({ error: 'Título: escríbalo' })
    .trim()
    .min(5, 'Título: escriba al menos 5 caracteres')
    .max(150, 'Título: máximo 150 caracteres'),
  descripcion: z.string().trim().max(1000, 'Descripción: máximo 1000 caracteres').default(''),
  desde: z.iso.date({ error: 'Vigente desde: use el formato AAAA-MM-DD' }),
  hasta: z.iso.date({ error: 'Vigente hasta: use el formato AAAA-MM-DD' }),
  preguntas: z.array(preguntaSchema).max(30, 'Preguntas: máximo 30'),
});

/** Encuestas de satisfacción (RF-NOV-04). Se monta bajo /admin/encuestas. */
export function rutasEncuestas(s: Servicios): Router {
  const r = Router();
  const administrar = requierePermisos('encuestas.administrar');
  const resultados = requierePermisos('encuestas.resultados');

  r.get('/', requiereAlguno('encuestas.administrar', 'encuestas.resultados'), async (_req, res) => {
    res.json({ items: await s.encuestas.listar() });
  });

  r.post('/', administrar, async (req, res) => {
    const d = encuestaSchema.parse(req.body);
    res.status(201).json(await s.encuestas.crear(req.actor!, d, contexto(req)));
  });

  r.get('/:id', administrar, async (req, res) => {
    res.json(await s.encuestas.obtener(idParam(req)));
  });

  r.put('/:id', administrar, async (req, res) => {
    const d = encuestaSchema.parse(req.body);
    res.json(await s.encuestas.actualizar(req.actor!, idParam(req), d, contexto(req)));
  });

  r.post('/:id/publicar', administrar, async (req, res) => {
    res.json(await s.encuestas.publicar(req.actor!, idParam(req), contexto(req)));
  });

  r.post('/:id/cerrar', administrar, async (req, res) => {
    res.json(await s.encuestas.cerrar(req.actor!, idParam(req), contexto(req)));
  });

  r.get('/:id/resultados', resultados, async (req, res) => {
    res.json(await s.encuestas.resultados(idParam(req)));
  });

  return r;
}
