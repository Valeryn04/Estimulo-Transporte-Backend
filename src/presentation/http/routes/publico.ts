import { MENSAJE_DIRECCION, esDireccionEstandar } from '../../../domain/direccion.js';
import { Router } from 'express';
import { z } from 'zod';
import type { Servicios } from '../../../container.js';
import {
  exigirTurnstile,
  type VerificadorTurnstile,
} from '../../../infrastructure/security/turnstile.js';
import type { TokenService } from '../../../infrastructure/security/tokens.js';
import type { CambiosCaracterizacion } from '../../../application/caracterizacion.js';
import { normalizarTelefono } from '../../../domain/caracterizacion.js';
import { badRequest } from '../../../shared/errors.js';
import { archivoDe, enviarArchivo, recibirArchivo } from '../subida.js';
import { autenticarCiudadano } from '../middlewares/auth.js';
import type { Limitadores } from '../middlewares/limites.js';

const NOMBRE_VALIDO = /^[\p{L}\p{M}'.\- ]+$/u;

const nombre = (etiqueta: string) =>
  z
    .string({ error: `${etiqueta}: escríbalo` })
    .trim()
    .min(3, `${etiqueta}: escriba al menos 3 caracteres`)
    .max(150, `${etiqueta}: máximo 150 caracteres`)
    .regex(NOMBRE_VALIDO, `${etiqueta}: use solo letras, espacios, punto, apóstrofo o guion`);

const id = (etiqueta: string) =>
  z
    .number({ error: `${etiqueta}: elija una opción de la lista` })
    .int(`${etiqueta}: elija una opción de la lista`)
    .positive(`${etiqueta}: elija una opción de la lista`);

const numero = (etiqueta: string) =>
  z
    .string({ error: `${etiqueta}: escríbalo` })
    .trim()
    .min(4, `${etiqueta}: escriba al menos 4 caracteres`)
    .max(25, `${etiqueta}: máximo 25 caracteres`);

const preinscripcionBase = z.object({
  pcdNombre: nombre('Nombre completo de la persona con discapacidad'),
  pcdTipoIdentificacionId: id('Tipo de identificación de la persona con discapacidad'),
  pcdNumero: numero('Número de identificación de la persona con discapacidad'),
  // Si la persona no tiene cuidador, se envía false y no se piden los datos del cuidador.
  tieneCuidador: z.boolean().optional(),
  // Quién llena el formulario: la persona con discapacidad o su cuidador.
  diligenciadaPor: z.enum(['PCD', 'CUIDADOR']).optional(),
  // Opcional; si se envía, debe tener el formato estándar de la dirección (el portal la arma por partes).
  direccion: z
    .string()
    .trim()
    .max(200, 'Dirección: máximo 200 caracteres')
    .refine((v) => v === '' || esDireccionEstandar(v), MENSAJE_DIRECCION)
    .nullish(),
  localidadId: z.number().int().positive().nullish(),
  barrioId: z.number().int().positive().nullish(),
  correo: z
    .string({ error: 'Correo electrónico: escríbalo' })
    .trim()
    .max(150, 'Correo electrónico: máximo 150 caracteres')
    .pipe(
      z.email({
        error: 'Correo electrónico: escriba un correo válido, por ejemplo nombre@correo.com',
      }),
    ),
  // Se escribe dos veces para evitar un error de digitación: el enlace de verificación llega a este correo.
  correoConfirmacion: z.string({ error: 'Confirmación del correo: escríbalo otra vez' }).trim(),
  aceptaAutorizacion: z.literal(true, {
    error: 'Autorización de datos: debe aceptarla para poder enviar la preinscripción',
  }),
  autorizacionVersion: z
    .number({ error: 'Autorización de datos: recargue la página' })
    .int()
    .positive(),
  formularioToken: z.string({ error: 'Recargue la página e intente de nuevo' }).min(10).max(2000),
  contactoAlterno: z.string().max(200).optional(),
});

const alRevisarCorreo = (d: { correo: string; correoConfirmacion: string }) =>
  d.correo.toLowerCase() === d.correoConfirmacion.toLowerCase();
const mensajeCorreo = {
  path: ['correoConfirmacion'],
  message: 'Confirmación del correo: los dos correos no coinciden, revíselos',
};

const datosCuidador = {
  cuidadorNombre: nombre('Nombre completo del cuidador'),
  cuidadorTipoIdentificacionId: id('Tipo de identificación del cuidador'),
  cuidadorNumero: numero('Número de identificación del cuidador'),
};

/** Sin cuidador: la persona no tiene a quien registrar. Con cuidador: sus datos son obligatorios. */
const preinscripcionSinCuidador = preinscripcionBase.refine(alRevisarCorreo, mensajeCorreo);
const preinscripcionConCuidador = preinscripcionBase
  .extend(datosCuidador)
  .refine(alRevisarCorreo, mensajeCorreo);

const verificarSchema = z.object({
  token: z.string({ error: 'El enlace no es válido' }).min(20).max(200),
});

const reenvioSchema = z.object({
  tipoIdentificacionId: id('Tipo de identificación'),
  numero: numero('Número de identificación'),
});

const radicadoSchema = z
  .string({ error: 'Número de radicado: escríbalo' })
  .trim()
  .toUpperCase()
  .regex(
    /^EST-\d{4}-\d{6}$/,
    'Número de radicado: escríbalo como aparece en su correo, por ejemplo EST-2026-000123',
  );

/** La solicitud se indica con el radicado o con el tipo y número de identificación de la PCD (RF-PRE-05). */
const consultaBase = z.object({
  radicado: radicadoSchema.optional(),
  tipoIdentificacionId: id('Tipo de identificación').optional(),
  numero: numero('Número de identificación').optional(),
  codigo: z.string().optional(),
});

function identificacionDeConsulta(
  d: z.infer<typeof consultaBase>,
  ctx: z.RefinementCtx,
): { radicado: string } | { tipoIdentificacionId: number; numero: string } {
  if (d.radicado) return { radicado: d.radicado };
  if (!d.tipoIdentificacionId) {
    ctx.addIssue({
      code: 'custom',
      path: ['tipoIdentificacionId'],
      message: 'Tipo de identificación: elija una opción de la lista',
    });
  }
  if (!d.numero) {
    ctx.addIssue({
      code: 'custom',
      path: ['numero'],
      message: 'Número de identificación: escríbalo',
    });
  }
  return { tipoIdentificacionId: d.tipoIdentificacionId ?? 0, numero: d.numero ?? '' };
}

const solicitudConsultaSchema = consultaBase.transform((d, ctx) =>
  identificacionDeConsulta(d, ctx),
);

const codigoSchema = consultaBase.transform((d, ctx) => {
  const codigo = /^\d{6}$/.test((d.codigo ?? '').trim()) ? (d.codigo as string).trim() : null;
  if (!codigo) {
    ctx.addIssue({ code: 'custom', path: ['codigo'], message: 'Código: son 6 dígitos' });
  }
  return { ...identificacionDeConsulta(d, ctx), codigo: codigo ?? '' };
});

const enlaceSchema = z.object({
  token: z.string({ error: 'El enlace no es válido' }).min(20).max(200),
});

// ---- caracterización (RF-CAR-01, RF-CAR-02, RF-CAR-04). Todos los campos son opcionales: se guarda el avance.

const vacioANulo = (v: string | null) => (v === '' ? null : v);

const textoCar = (etiqueta: string, min: number, max: number) =>
  z
    .string({ error: `${etiqueta}: escríbalo` })
    .trim()
    .max(max, `${etiqueta}: máximo ${max} caracteres`)
    .nullable()
    .transform(vacioANulo)
    .refine(
      (v) => v === null || v.length >= min,
      `${etiqueta}: escriba al menos ${min} caracteres`,
    );

const telefonoCar = (etiqueta: string, patron: RegExp, ayuda: string) =>
  z
    .string({ error: `${etiqueta}: escríbalo` })
    .max(30, `${etiqueta}: demasiado largo`)
    .nullable()
    .transform((v) => (v === null ? null : vacioANulo(normalizarTelefono(v))))
    .refine((v) => v === null || patron.test(v), `${etiqueta}: ${ayuda}`);

const celularCar = (etiqueta: string) =>
  telefonoCar(
    etiqueta,
    /^3\d{9}$/,
    'escriba 10 dígitos y que empiece por 3, por ejemplo 300 123 4567',
  );

const fijoCar = (etiqueta: string) =>
  telefonoCar(etiqueta, /^(\d{7}|60\d{8})$/, 'escriba 7 dígitos, o 10 si incluye el indicativo 60');

const listaCar = (etiqueta: string) =>
  z
    .number({ error: `${etiqueta}: elija una opción de la lista` })
    .int(`${etiqueta}: elija una opción de la lista`)
    .positive(`${etiqueta}: elija una opción de la lista`)
    .nullable();

const siNoCar = (etiqueta: string) =>
  z.boolean({ error: `${etiqueta}: responda sí o no` }).nullable();

const fechaCar = z
  .string({ error: 'Fecha de nacimiento: escríbala como día, mes y año' })
  .nullable()
  .transform(vacioANulo)
  .refine((v) => {
    if (v === null) return true;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const f = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(f.getTime()) && f.toISOString().slice(0, 10) === v;
  }, 'Fecha de nacimiento: escriba una fecha válida');

const entero = (etiqueta: string, min: number, max: number, ayuda: string) =>
  z
    .number({ error: `${etiqueta}: ${ayuda}` })
    .int(`${etiqueta}: escriba un número entero`)
    .min(min, `${etiqueta}: ${ayuda}`)
    .max(max, `${etiqueta}: ${ayuda}`)
    .nullable();

const caracterizacionSchema = z
  .object({
    version: z.number({ error: 'Recargue la página' }).int().min(0),
    pcdNombre: nombre('Nombre completo de la persona con discapacidad'),
    cuidadorNombre: nombre('Nombre completo del cuidador'),
    generoId: listaCar('Género'),
    telefonoFijo: fijoCar('Teléfono fijo'),
    celular: celularCar('Celular'),
    fechaNacimiento: fechaCar,
    estadoCivilId: listaCar('Estado civil'),
    tieneHijos: siNoCar('Hijos'),
    hijosCantidad: entero('Cuántos hijos tiene', 1, 20, 'escriba un número entre 1 y 20'),
    hijosEdades: z
      .array(entero('Edad del hijo', 0, 100, 'escriba un valor entre 0 y 100'))
      .max(20)
      .nullable(),
    etniaId: listaCar('Etnia'),
    escolaridadId: listaCar('Nivel de escolaridad'),
    ocupacionId: listaCar('Ocupación'),
    epsId: listaCar('EPS'),
    embarazo: z
      .enum(['NO', 'SI', 'NO_APLICA'], { error: 'Estado de embarazo: elija una opción' })
      .nullable(),
    semanasGestacion: entero('Tiempo de gestación', 1, 42, 'escriba entre 1 y 42 semanas'),
    recibeSubsidios: siNoCar('Subsidios de otras entidades'),
    subsidioCual: textoCar('Cuál subsidio, renta o beneficio', 3, 200),
    tipoTransporteId: listaCar('Tipo de transporte'),
    justificacionTransporte: textoCar('Justificación del tipo de transporte', 3, 500),
    requiereCuidador: siNoCar('Servicio para el cuidador'),
    cuidadorGeneroId: listaCar('Género del cuidador'),
    cuidadorTelefonoFijo: fijoCar('Teléfono fijo del cuidador'),
    cuidadorCelular: celularCar('Celular del cuidador'),
    cuidadorCorreo: z
      .string({ error: 'Correo del cuidador: escríbalo' })
      .trim()
      .max(150, 'Correo del cuidador: máximo 150 caracteres')
      .nullable()
      .transform(vacioANulo)
      .refine(
        (v) => v === null || z.email().safeParse(v).success,
        'Correo del cuidador: escriba un correo válido, por ejemplo nombre@correo.com',
      ),
  })
  .partial()
  .required({ version: true })
  .strict();

/** Portal ciudadano: no requiere sesión. Cada ruta lleva su límite de peticiones (RNF-04). */
export function rutasPublicas(
  s: Servicios,
  limites: Limitadores,
  tokens: TokenService,
  turnstile: VerificadorTurnstile,
): Router {
  const r = Router();
  const robot = exigirTurnstile(turnstile);

  /** Configuración que necesita el portal antes de pintar los formularios. */
  r.get('/config', (_req, res) => {
    res.json({ turnstileSiteKey: turnstile.siteKey });
  });

  /** Datos del formulario de preinscripción: catálogos activos, texto de autorización y token anti-automatización. */
  r.get('/preinscripcion/formulario', limites.formulario, async (_req, res) => {
    res.json(await s.preinscripcion.formulario());
  });

  r.post('/preinscripciones', limites.preinscripcion, robot, async (req, res) => {
    const sinCuidador =
      (req.body as { tieneCuidador?: unknown } | undefined)?.tieneCuidador === false;
    const d = sinCuidador
      ? preinscripcionSinCuidador.parse(req.body)
      : preinscripcionConCuidador.parse(req.body);
    const resultado = await s.preinscripcion.preinscribir(d, {
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
    res.status(201).json({
      correoEnmascarado: resultado.correoEnmascarado,
      horasVigenciaEnlace: resultado.horasVigenciaEnlace,
    });
  });

  r.post('/preinscripciones/verificar-correo', limites.verificacion, async (req, res) => {
    const { token } = verificarSchema.parse(req.body);
    res.json(await s.preinscripcion.verificarCorreo(token, { ip: req.ip ?? null }));
  });

  r.post('/preinscripciones/reenviar-verificacion', limites.reenvio, robot, async (req, res) => {
    const d = reenvioSchema.parse(req.body);
    await s.preinscripcion.reenviarVerificacion(d, { ip: req.ip ?? null });
    // Respuesta idéntica exista o no la solicitud: no se revela qué identificaciones están registradas.
    res.status(202).json({
      mensaje:
        'Si existe una preinscripción pendiente de verificación para esa identificación, enviamos de nuevo el enlace al correo registrado.',
    });
  });

  // ---- consulta del estado (RF-PRE-05)

  /** Envía un código de un solo uso al correo verificado. Responde igual exista o no la solicitud. */
  r.post('/consulta/solicitar-codigo', limites.codigo, robot, async (req, res) => {
    const d = solicitudConsultaSchema.parse(req.body);
    await s.consulta.solicitarCodigo(d, { ip: req.ip ?? null });
    res.status(202).json({
      mensaje:
        'Si existe una solicitud con esos datos y su correo está verificado, enviamos un código a ese correo.',
    });
  });

  r.post('/consulta/verificar-codigo', limites.acceso, async (req, res) => {
    const d = codigoSchema.parse(req.body);
    res.json(await s.consulta.verificarCodigo(d, { ip: req.ip ?? null }));
  });

  r.post('/consulta/enlace', limites.acceso, async (req, res) => {
    const { token } = enlaceSchema.parse(req.body);
    res.json(await s.consulta.accederPorEnlace(token, { ip: req.ip ?? null }));
  });

  /** Estado de la solicitud: solo con la sesión que da el código o el enlace seguro. */
  r.get('/consulta/solicitud', autenticarCiudadano(tokens), async (req, res) => {
    res.json(await s.consulta.consultar(req.solicitudId as number));
  });

  // ---- descargos de la persona en una revocatoria (RF-BEN-04)

  /** El trámite de revocatoria en curso: razones, plazo y si todavía puede presentar descargos. */
  r.get('/consulta/revocatoria', autenticarCiudadano(tokens), async (req, res) => {
    res.json({
      revocatoria: await s.novedades.revocatoriaParaLaPersona(req.solicitudId as number),
    });
  });

  /** La persona presenta sus descargos (texto y, si quiere, un archivo) dentro del plazo. */
  r.post(
    '/consulta/descargos',
    limites.documentos,
    autenticarCiudadano(tokens),
    recibirArchivo,
    async (req, res) => {
      const { texto } = z
        .object({
          texto: z
            .string({ error: 'Descargos: escríbalos' })
            .trim()
            .min(10, 'Descargos: cuéntenos qué desea responder (mínimo 10 caracteres)')
            .max(4000, 'Descargos: máximo 4000 caracteres'),
        })
        .parse(req.body);
      await s.novedades.descargosDeLaPersona(
        req.solicitudId as number,
        { texto },
        req.file ? archivoDe(req) : null,
        { ip: req.ip ?? null },
      );
      res
        .status(201)
        .json({ mensaje: 'Recibimos sus descargos. Serán tenidos en cuenta en la decisión.' });
    },
  );

  // ---- encuesta de satisfacción (RF-NOV-04): con el enlace personal que llega por correo

  r.get('/encuesta', limites.acceso, async (req, res) => {
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(req.query);
    res.json(await s.encuestas.paraResponder(token));
  });

  r.post('/encuesta/responder', limites.acceso, async (req, res) => {
    const d = z
      .object({
        token: z.string().min(20).max(200),
        respuestas: z.record(z.string(), z.union([z.string().max(1000), z.number()])),
      })
      .parse(req.body);
    await s.encuestas.responder(d.token, d.respuestas, { ip: req.ip ?? null });
    res.status(201).json({ mensaje: 'Gracias por responder la encuesta.' });
  });

  // ---- caracterización: solo con la sesión que da el código o el enlace seguro

  r.get('/caracterizacion', autenticarCiudadano(tokens), async (req, res) => {
    res.json(await s.caracterizacion.obtener(req.solicitudId as number));
  });

  /** Guarda el avance. Solo cambian los campos enviados. */
  r.patch(
    '/caracterizacion',
    limites.caracterizacion,
    autenticarCiudadano(tokens),
    async (req, res) => {
      const d = caracterizacionSchema.parse(req.body);
      res.json(
        await s.caracterizacion.guardar(req.solicitudId as number, d as CambiosCaracterizacion, {
          ip: req.ip ?? null,
        }),
      );
    },
  );

  // ---- documentos soporte y radicación (RF-CAR-03, RF-CAR-04)

  const documentoParam = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) {
      throw badRequest('DOCUMENTO_INVALIDO', 'El documento indicado no es válido');
    }
    return n;
  };

  /** Documentos que le corresponden a la solicitud, con su estado y las reglas de carga. */
  r.get('/caracterizacion/documentos', autenticarCiudadano(tokens), async (req, res) => {
    res.json(await s.documentos.listar(req.solicitudId as number));
  });

  /** Carga o reemplaza un documento. */
  r.post(
    '/caracterizacion/documentos/:documentoId',
    limites.documentos,
    autenticarCiudadano(tokens),
    recibirArchivo,
    async (req, res) => {
      res
        .status(201)
        .json(
          await s.documentos.cargar(
            req.solicitudId as number,
            documentoParam(req.params.documentoId),
            archivoDe(req),
            { ip: req.ip ?? null },
          ),
        );
    },
  );

  /** La persona descarga el archivo que cargó. */
  r.get(
    '/caracterizacion/documentos/:documentoId/archivo',
    autenticarCiudadano(tokens),
    async (req, res) => {
      const a = await s.documentos.descargar(
        req.solicitudId as number,
        documentoParam(req.params.documentoId),
      );
      enviarArchivo(res, a);
    },
  );

  /** Filtro de régimen de salud: consulta con el documento de la persona si es subsidiada y adjunta la constancia. */
  r.get('/caracterizacion/regimen', autenticarCiudadano(tokens), async (req, res) => {
    res.json({
      consulta: await s.documentos.consultarRegimen(req.solicitudId as number, {
        ip: req.ip ?? null,
      }),
    });
  });

  /** La carta que genera el sistema con los datos escritos, para verla mientras se llena el formulario. */
  r.get(
    '/caracterizacion/documentos/:documentoId/carta',
    autenticarCiudadano(tokens),
    async (req, res) => {
      enviarArchivo(
        res,
        await s.documentos.vistaPreviaCarta(
          req.solicitudId as number,
          documentoParam(req.params.documentoId),
        ),
      );
    },
  );

  /** Lo que se le pidió corregir al ciudadano (observación del validador y plazo), si hay una subsanación. */
  r.get('/caracterizacion/subsanacion', autenticarCiudadano(tokens), async (req, res) => {
    res.json({ subsanacion: await s.subsanacion.obtener(req.solicitudId as number) });
  });

  /** El ciudadano envía sus correcciones: el caso vuelve a la bandeja de validación (RF-CAR-06). */
  r.post(
    '/caracterizacion/subsanacion/responder',
    limites.documentos,
    autenticarCiudadano(tokens),
    async (req, res) => {
      res.json(await s.subsanacion.responder(req.solicitudId as number, { ip: req.ip ?? null }));
    },
  );

  /** Qué falta para poder enviar la solicitud: datos obligatorios y documentos. */
  r.get('/caracterizacion/revision', autenticarCiudadano(tokens), async (req, res) => {
    res.json(await s.radicacion.pendientes(req.solicitudId as number));
  });

  /** Envía la solicitud: valida que esté completa, genera el radicado y notifica por correo. */
  r.post(
    '/caracterizacion/radicar',
    limites.documentos,
    autenticarCiudadano(tokens),
    async (req, res) => {
      res
        .status(201)
        .json(await s.radicacion.radicar(req.solicitudId as number, { ip: req.ip ?? null }));
    },
  );

  /** Modelo descargable de un documento (carta de solicitud, carta de cuidado), si la Gerencia lo publicó. */
  r.get('/documentos/:documentoId/modelo', limites.formulario, async (req, res) => {
    enviarArchivo(res, await s.documentos.modelo(documentoParam(req.params.documentoId)));
  });

  return r;
}
