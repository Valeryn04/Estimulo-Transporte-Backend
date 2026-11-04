import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import { errorValidacion } from '../../../application/esquemas.js';
import { requiereAlguno, requierePermisos } from '../middlewares/auth.js';
import { archivoDe, enviarArchivo, recibirArchivo } from '../subida.js';
import { contexto, idParam, paginacionSchema } from '../utilidades.js';

const vigenciaSchema = z.coerce.number().int().positive().optional();

const itemDistribucionSchema = z.object({
  itemId: z.number({ error: 'Distribución: elija un elemento' }).int().positive(),
  cupos: z
    .number({ error: 'Distribución: escriba los cupos' })
    .int('Distribución: los cupos son un número entero')
    .min(0, 'Distribución: los cupos no pueden ser negativos')
    .max(10_000_000),
});

const ajusteSchema = z.object({
  cuposTotales: z
    .number({ error: 'Cupos: escriba un número' })
    .int('Cupos: escriba un número entero')
    .min(0, 'Cupos: no pueden ser negativos')
    .max(10_000_000, 'Cupos: demasiado grande')
    .optional(),
  valorEstimulo: z
    .number({ error: 'Valor del estímulo: escriba un número' })
    .min(0, 'Valor del estímulo: no puede ser negativo')
    .max(1_000_000_000, 'Valor del estímulo: demasiado grande')
    .optional(),
  presupuestoTotal: z
    .number({ error: 'Presupuesto: escriba un número' })
    .min(0, 'Presupuesto: no puede ser negativo')
    .max(10_000_000_000_000, 'Presupuesto: demasiado grande')
    .optional(),
  // Lo que la pantalla tenía cargado: si otra persona lo cambió mientras tanto, no se pisa su cambio.
  base: z
    .object({
      cuposTotales: z.number().optional(),
      valorEstimulo: z.number().optional(),
      presupuestoTotal: z.number().optional(),
    })
    .optional(),
  distribucionLocalidad: z.array(itemDistribucionSchema).max(100).optional(),
  distribucionTransporte: z.array(itemDistribucionSchema).max(100).optional(),
  motivo: z
    .string({ error: 'Motivo: escríbalo' })
    .trim()
    .max(1000, 'Motivo: máximo 1000 caracteres'),
});

const asignarSchema = z.object({
  vigenciaId: z.number().int().positive().optional(),
  solicitudIds: z
    .array(z.number().int().positive(), { error: 'Casos: elija al menos un caso' })
    .min(1, 'Casos: elija al menos un caso')
    .max(500),
  omisiones: z
    .array(
      z.object({
        solicitudId: z.number().int().positive(),
        causa: z.string().trim().max(500, 'Causa: máximo 500 caracteres'),
      }),
    )
    .max(500)
    .default([]),
});

const listaEsperaSchema = z.object({
  vigenciaId: z.number().int().positive().optional(),
  solicitudIds: z.array(z.number().int().positive()).max(500).optional(),
});

const entregaSchema = z.object({
  rol: z.enum(['PCD', 'CUIDADOR'], { error: 'Persona: elija quién recibe la tarjeta' }),
  tarjetaId: z
    .string({ error: 'Identificador de la tarjeta: escríbalo' })
    .trim()
    .min(4, 'Identificador de la tarjeta: escriba al menos 4 caracteres')
    .max(30, 'Identificador de la tarjeta: máximo 30 caracteres'),
  tipoTransporteId: z
    .number({ error: 'Tipo de transporte: elija uno de la lista' })
    .int()
    .positive('Tipo de transporte: elija uno de la lista'),
  fechaEntrega: z.iso.date({ error: 'Fecha de entrega: use el formato AAAA-MM-DD' }),
  receptorTipo: z.enum(['PCD', 'CUIDADOR', 'TERCERO'], { error: 'Receptor: elija quién recibió' }),
  receptorNombre: z
    .string()
    .trim()
    .max(150, 'Nombre de quien recibe: máximo 150 caracteres')
    .optional(),
  receptorTipoIdentificacionId: z.number().int().positive().optional(),
  receptorNumero: z.string().trim().max(30, 'Número de documento: máximo 30 caracteres').optional(),
  // El funcionario que entrega es quien tiene la sesión abierta: ya no se escribe.
  terceroConAutorizacion: z.boolean().optional(),
});

const activarSchema = z.object({
  observacion: z.string().trim().max(500, 'Observación: máximo 500 caracteres').default(''),
});

const propuestaSchema = paginacionSchema.extend({ vigenciaId: vigenciaSchema });

const beneficiariosSchema = paginacionSchema.extend({
  vigenciaId: vigenciaSchema,
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

/**
 * Cupos y presupuesto (RF-ASI-01), asignación (RF-ASI-02), lista de espera (RF-ASI-03) y beneficiarios. Se monta bajo
 * /admin/asignacion.
 */
export function rutasAsignacion(s: Servicios): Router {
  const r = Router();
  const ver = requierePermisos('asignacion.ver');
  const verCupos = requiereAlguno('asignacion.ver', 'cupos.administrar');
  const asignar = requierePermisos('asignacion.asignar');
  const administrar = requierePermisos('cupos.administrar');

  r.get('/cupos', verCupos, async (req, res) => {
    res.json(await s.asignacion.finanzas(vigenciaSchema.parse(req.query.vigenciaId)));
  });

  /** Modificar cupos, valor, presupuesto o distribución: multipart con `datos` (JSON) y el soporte en `archivo`. */
  r.put('/cupos', administrar, recibirArchivo, async (req, res) => {
    let crudo: unknown;
    try {
      crudo = JSON.parse(String((req.body as Record<string, unknown>)?.datos ?? ''));
    } catch {
      throw errorValidacion([
        { campo: 'datos', mensaje: 'Datos: envíe el cambio en el campo «datos»' },
      ]);
    }
    const parsed = ajusteSchema.safeParse(crudo);
    if (!parsed.success) {
      throw errorValidacion(
        parsed.error.issues.map((i) => ({
          campo: String(i.path[0] ?? 'datos'),
          mensaje: i.message,
        })),
      );
    }
    const vigenciaId = vigenciaSchema.parse(req.query.vigenciaId);
    res.json(
      await s.asignacion.ajustar(
        req.actor!,
        vigenciaId,
        parsed.data,
        req.file ? archivoDe(req) : null,
        contexto(req),
      ),
    );
  });

  r.get('/cupos/ajustes', verCupos, async (req, res) => {
    res.json({ items: await s.asignacion.ajustes(vigenciaSchema.parse(req.query.vigenciaId)) });
  });

  r.get('/cupos/ajustes/:id/soporte', verCupos, async (req, res) => {
    enviarArchivo(res, await s.asignacion.soporteDeAjuste(idParam(req)));
  });

  r.get('/propuesta', ver, async (req, res) => {
    const f = propuestaSchema.parse(req.query);
    res.json(
      await s.asignacion.propuesta({
        vigenciaId: f.vigenciaId,
        limit: f.tamano,
        offset: (f.pagina - 1) * f.tamano,
      }),
    );
  });

  r.post('/asignar', asignar, async (req, res) => {
    const d = asignarSchema.parse(req.body);
    res.status(201).json(await s.asignacion.asignar(req.actor!, d, contexto(req)));
  });

  r.post('/lista-espera', asignar, async (req, res) => {
    const d = listaEsperaSchema.parse(req.body ?? {});
    res.json(await s.asignacion.enviarAListaEspera(req.actor!, d, contexto(req)));
  });

  r.get('/beneficiarios', ver, async (req, res) => {
    const f = beneficiariosSchema.parse(req.query);
    res.json(
      await s.asignacion.beneficiarios({
        vigenciaId: f.vigenciaId,
        estado: f.estado,
        q: f.q || undefined,
        limit: f.tamano,
        offset: (f.pagina - 1) * f.tamano,
      }),
    );
  });

  // ---- entrega y activación (RF-ASI-05, RF-ASI-06)

  /** Planilla de entrega para firmar el día de la entrega: `?beneficios=1,2,3`. */
  r.get('/actas-entrega', ver, async (req, res) => {
    const ids = z
      .string({ error: 'Beneficios: indique cuáles' })
      .regex(/^\d+(,\d+){0,99}$/, 'Beneficios: indique los números separados por comas')
      .parse(req.query.beneficios)
      .split(',')
      .map(Number);
    enviarArchivo(res, await s.entregas.actaDeEntrega(req.actor!, ids));
  });

  r.get('/beneficiarios/:id', ver, async (req, res) => {
    res.json(await s.entregas.detalle(idParam(req)));
  });

  /** Registrar la entrega de la tarjeta: multipart con `datos` (JSON) y el acta firmada en `archivo`. */
  r.post('/beneficiarios/:id/entregas', asignar, recibirArchivo, async (req, res) => {
    let crudo: unknown;
    try {
      crudo = JSON.parse(String((req.body as Record<string, unknown>)?.datos ?? ''));
    } catch {
      throw errorValidacion([
        { campo: 'datos', mensaje: 'Datos: envíe la entrega en el campo «datos»' },
      ]);
    }
    const parsed = entregaSchema.safeParse(crudo);
    if (!parsed.success) {
      throw errorValidacion(
        parsed.error.issues.map((i) => ({
          campo: String(i.path[0] ?? 'datos'),
          mensaje: i.message,
        })),
      );
    }
    const archivo = archivoDe(req);
    res
      .status(201)
      .json(
        await s.entregas.registrar(req.actor!, idParam(req), parsed.data, archivo, contexto(req)),
      );
  });

  r.post('/beneficiarios/:id/activar', asignar, async (req, res) => {
    const d = activarSchema.parse(req.body ?? {});
    res.json(await s.entregas.activar(req.actor!, idParam(req), d.observacion, contexto(req)));
  });

  r.get('/entregas/:id/soporte', ver, async (req, res) => {
    enviarArchivo(res, await s.entregas.soporte(idParam(req)));
  });

  return r;
}
