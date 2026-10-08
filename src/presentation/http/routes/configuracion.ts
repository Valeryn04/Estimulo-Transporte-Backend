import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { CATALOGOS, type Catalogo } from '../../../infrastructure/repositories/catalogos.js';
import { badRequest } from '../../../shared/errors.js';
import { archivoDe, recibirArchivo } from '../subida.js';
import { requierePermisos } from '../middlewares/auth.js';
import { contexto, idParam, paginacionSchema } from '../utilidades.js';

const nombre = (campo: string, min = 2, max = 150) =>
  z
    .string({ error: `${campo}: escríbalo` })
    .trim()
    .min(min, `${campo}: escriba al menos ${min} caracteres`)
    .max(max, `${campo}: máximo ${max} caracteres`);

/** Posición en la lista: cada elemento tiene la suya (si se pide una ocupada, los demás se corren). */
const posicion = z
  .number({ error: 'Orden: escriba un número' })
  .int('Orden: escriba un número entero')
  .min(1, 'Orden: desde 1')
  .max(100000, 'Orden: máximo 100000');
const orden = posicion.optional();

const itemSchema = z.object({
  nombre: nombre('Nombre'),
  codigo: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{1,40}$/, 'Código: use solo letras, números y guion bajo')
    .optional(),
  padreId: z.number().int().positive().nullable().optional(),
  orden,
});

const moverSchema = z.object({ orden: posicion });

const documentoSchema = z.object({
  nombre: nombre('Nombre', 3),
  descripcion: z.string().trim().max(500, 'Descripción: máximo 500 caracteres').default(''),
  aplicaA: z.enum(['PCD', 'CUIDADOR', 'COMUN'], { error: 'Aplica a: elija una opción' }),
  obligatorio: z.boolean({ error: 'Obligatorio: indique si es obligatorio' }),
  orden,
});

const filtroItemsSchema = paginacionSchema.extend({
  q: z.string().trim().max(100).optional(),
  activo: z.enum(['true', 'false']).optional(),
  padreId: z.coerce.number().int().positive().optional(),
  orden: z.coerce.number().int().min(1).optional(),
});

const versionParametroSchema = z.object({
  valor: z.string({ error: 'Valor: escríbalo' }).trim().min(1, 'Valor: escríbalo').max(500),
  vigenteDesde: z.iso
    .datetime({ error: 'Vigente desde: fecha y hora inválidas' })
    .nullable()
    .default(null),
  justificacion: nombre('Justificación', 5, 500),
});

const fechaSchema = (campo: string) => z.iso.date({ error: `${campo}: use el formato AAAA-MM-DD` });
const cuposSchema = z
  .number({ error: 'Cupos: escriba un número' })
  .int('Cupos: escriba un número entero')
  .min(0, 'Cupos: no puede ser negativo')
  .max(10_000_000);

const vigenciaNuevaSchema = z.object({
  anio: z
    .number({ error: 'Año: escríbalo' })
    .int()
    .min(2020, 'Año: desde 2020')
    .max(2100, 'Año: hasta 2100'),
  fechaInicio: fechaSchema('Fecha inicial'),
  fechaFin: fechaSchema('Fecha final'),
  cuposTotales: cuposSchema,
});
const vigenciaEdicionSchema = vigenciaNuevaSchema.omit({ anio: true });

const autorizacionSchema = z.object({
  contenido: z
    .string({ error: 'Texto: escríbalo' })
    .trim()
    .min(50, 'Texto: escriba al menos 50 caracteres')
    .max(20000, 'Texto: máximo 20.000 caracteres'),
});

const plantillaSchema = z.object({
  asunto: nombre('Asunto', 5, 200),
  cuerpo: nombre('Texto', 20, 10000),
});
const plantillaVersionSchema = plantillaSchema.extend({
  justificacion: z.string().trim().max(500).nullable().default(null),
});

function catalogoParam(valor: unknown): Catalogo {
  if (typeof valor !== 'string' || !(CATALOGOS as readonly string[]).includes(valor)) {
    throw badRequest('CATALOGO_INVALIDO', 'La lista indicada no existe');
  }
  return valor as Catalogo;
}

const codigoPlantilla = (v: unknown) => {
  if (typeof v !== 'string' || !/^[A-Z_]{3,60}$/.test(v)) {
    throw badRequest('PLANTILLA_INVALIDA', 'La plantilla indicada no es válida');
  }
  return v;
};

/**
 * Configuración del programa (RF-ADM-02, RF-PRE-03, RF-COM-02): catálogos, documentos exigidos, parámetros
 * versionados, vigencias y cupos, texto de autorización y plantillas de correo. Se monta bajo /admin, ya
 * autenticado; cada grupo exige su permiso también en la API.
 */
export function rutasConfiguracion(s: Servicios): Router {
  const r = Router();
  const catalogos = requierePermisos('catalogos.administrar');
  const parametros = requierePermisos('parametros.administrar');
  const plantillas = requierePermisos('plantillas.administrar');

  // ---- catálogos
  r.get('/catalogos', catalogos, async (_req, res) => {
    res.json({ items: await s.catalogos.resumen() });
  });

  r.get('/catalogos/:catalogo/items', catalogos, async (req, res) => {
    const f = filtroItemsSchema.parse(req.query);
    const { items, total } = await s.catalogos.listar(catalogoParam(req.params.catalogo), {
      q: f.q || undefined,
      activo: f.activo === undefined ? undefined : f.activo === 'true',
      padreId: f.padreId,
      orden: f.orden,
      limit: f.tamano,
      offset: (f.pagina - 1) * f.tamano,
    });
    res.json({ items, total, pagina: f.pagina, tamano: f.tamano });
  });

  r.post('/catalogos/:catalogo/items', catalogos, async (req, res) => {
    const d = itemSchema.parse(req.body);
    res
      .status(201)
      .json(
        await s.catalogos.crear(req.actor!, catalogoParam(req.params.catalogo), d, contexto(req)),
      );
  });

  r.put('/catalogos/items/:id', catalogos, async (req, res) => {
    const d = itemSchema.parse(req.body);
    res.json(await s.catalogos.actualizar(req.actor!, idParam(req), d, contexto(req)));
  });

  /** Reordena: lleva el elemento a la posición indicada (arrastrar y soltar). */
  r.post('/catalogos/items/:id/mover', catalogos, async (req, res) => {
    const d = moverSchema.parse(req.body);
    res.json(await s.catalogos.mover(req.actor!, idParam(req), d.orden, contexto(req)));
  });

  r.post('/catalogos/items/:id/activar', catalogos, async (req, res) => {
    res.json(await s.catalogos.cambiarActivo(req.actor!, idParam(req), true, contexto(req)));
  });

  r.post('/catalogos/items/:id/desactivar', catalogos, async (req, res) => {
    res.json(await s.catalogos.cambiarActivo(req.actor!, idParam(req), false, contexto(req)));
  });

  r.get('/catalogos/items/:id/versiones', catalogos, async (req, res) => {
    res.json({ items: await s.catalogos.versiones(idParam(req)) });
  });

  // ---- documentos exigidos
  r.get('/documentos-requeridos', catalogos, async (_req, res) => {
    res.json({ items: await s.catalogos.documentos() });
  });

  r.post('/documentos-requeridos', catalogos, async (req, res) => {
    const d = documentoSchema.parse(req.body);
    res.status(201).json(await s.catalogos.crearDocumento(req.actor!, d, contexto(req)));
  });

  r.put('/documentos-requeridos/:id', catalogos, async (req, res) => {
    const d = documentoSchema.parse(req.body);
    res.json(await s.catalogos.actualizarDocumento(req.actor!, idParam(req), d, contexto(req)));
  });

  r.post('/documentos-requeridos/:id/mover', catalogos, async (req, res) => {
    const d = moverSchema.parse(req.body);
    res.json(await s.catalogos.moverDocumento(req.actor!, idParam(req), d.orden, contexto(req)));
  });

  r.post('/documentos-requeridos/:id/activar', catalogos, async (req, res) => {
    res.json(
      await s.catalogos.cambiarActivoDocumento(req.actor!, idParam(req), true, contexto(req)),
    );
  });

  r.post('/documentos-requeridos/:id/desactivar', catalogos, async (req, res) => {
    res.json(
      await s.catalogos.cambiarActivoDocumento(req.actor!, idParam(req), false, contexto(req)),
    );
  });

  /** Publica o reemplaza el modelo descargable de un documento (por ejemplo, la carta de solicitud). */
  r.put('/documentos-requeridos/:id/modelo', catalogos, recibirArchivo, async (req, res) => {
    res.json(
      await s.documentos.guardarModelo(req.actor!.id, idParam(req), archivoDe(req), contexto(req)),
    );
  });

  r.get('/documentos-requeridos/:id/versiones', catalogos, async (req, res) => {
    res.json({ items: await s.catalogos.versionesDocumento(idParam(req)) });
  });

  // ---- parámetros versionados
  r.get('/parametros', parametros, async (_req, res) => {
    res.json({ items: await s.parametros.listar() });
  });

  r.get('/parametros/:clave/historial', parametros, async (req, res) => {
    res.json({ items: await s.parametros.historial(String(req.params.clave)) });
  });

  r.post('/parametros/:clave/versiones', parametros, async (req, res) => {
    const d = versionParametroSchema.parse(req.body);
    res
      .status(201)
      .json(
        await s.parametros.nuevaVersion(req.actor!, String(req.params.clave), d, contexto(req)),
      );
  });

  // ---- vigencias y cupos
  r.get('/vigencias', parametros, async (_req, res) => {
    res.json({ items: await s.parametros.vigencias() });
  });

  r.post('/vigencias', parametros, async (req, res) => {
    const d = vigenciaNuevaSchema.parse(req.body);
    res.status(201).json(await s.parametros.crearVigencia(req.actor!, d, contexto(req)));
  });

  r.put('/vigencias/:id', parametros, async (req, res) => {
    const d = vigenciaEdicionSchema.parse(req.body);
    res.json(await s.parametros.actualizarVigencia(req.actor!, idParam(req), d, contexto(req)));
  });

  r.post('/vigencias/:id/activar', parametros, async (req, res) => {
    res.json(await s.parametros.activarVigencia(req.actor!, idParam(req), contexto(req)));
  });

  r.get('/vigencias/:id/versiones', parametros, async (req, res) => {
    res.json({ items: await s.parametros.versionesVigencia(idParam(req)) });
  });

  // ---- texto de autorización de datos
  r.get('/autorizacion', parametros, async (_req, res) => {
    res.json(await s.parametros.autorizacion());
  });

  r.post('/autorizacion', parametros, async (req, res) => {
    const d = autorizacionSchema.parse(req.body);
    res
      .status(201)
      .json(await s.parametros.nuevaAutorizacion(req.actor!, d.contenido, contexto(req)));
  });

  // ---- plantillas de correo
  r.get('/plantillas', plantillas, async (_req, res) => {
    res.json({ items: await s.plantillas.listar() });
  });

  r.get('/plantillas/:codigo', plantillas, async (req, res) => {
    res.json(await s.plantillas.obtener(codigoPlantilla(req.params.codigo)));
  });

  r.post('/plantillas/:codigo/vista-previa', plantillas, async (req, res) => {
    const d = plantillaSchema.parse(req.body);
    res.json(await s.plantillas.vistaPrevia(codigoPlantilla(req.params.codigo), d));
  });

  r.post('/plantillas/:codigo/versiones', plantillas, async (req, res) => {
    const d = plantillaVersionSchema.parse(req.body);
    res
      .status(201)
      .json(
        await s.plantillas.nuevaVersion(
          req.actor!,
          codigoPlantilla(req.params.codigo),
          d,
          contexto(req),
        ),
      );
  });

  return r;
}
