import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Dependencias } from '../../application/contexto.js';
import { crearServicios, type Servicios } from '../../container.js';
import { publicarDocumentacion } from './documentacion.js';
import { cuerpoError, manejadorErrores, rutaNoEncontrada } from './middlewares/errores.js';
import { restriccionIp } from './middlewares/ip.js';
import { crearLimitadores } from './middlewares/limites.js';
import { rutasAdmin } from './routes/admin.js';
import { rutasAuth } from './routes/auth.js';
import { rutasPublicas } from './routes/publico.js';
import { forbidden } from '../../shared/errors.js';

// Mensajes de validación por defecto en español para los casos no personalizados.
z.config(z.locales.es());

const webhookCorreoSchema = z.object({
  messageId: z.string().min(3).max(300),
  evento: z.enum(['ENTREGADO', 'REBOTADO']),
  detalle: z.string().max(500).optional(),
});

export interface Aplicacion {
  app: Express;
  servicios: Servicios;
}

export function crearAplicacion(
  deps: Dependencias,
  opciones: { limitarIntentos?: boolean } = {},
): Aplicacion {
  const { env } = deps;
  const servicios = crearServicios(deps);
  const limites = crearLimitadores(opciones.limitarIntentos ?? env.nodeEnv !== 'test');
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy);
  app.use(helmet());
  app.use(
    cors({
      origin: env.frontendOrigenes,
      // La cookie del refresh token viaja con las llamadas del portal interno (origen único, nunca «*»).
      credentials: true,
      exposedHeaders: ['Content-Disposition'],
      maxAge: 600,
    }),
  );
  // Las respuestas de la API contienen datos personales: ningún navegador ni intermediario debe guardarlas.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  const v1 = express.Router();
  /** Estado del servicio y de la base de datos (monitoreo, RNF-08). */
  v1.get('/health', async (_req, res) => {
    try {
      await deps.pool.query('SELECT 1');
      res.json({ estado: 'ok', baseDeDatos: 'ok' });
    } catch {
      res.status(503).json({ estado: 'degradado', baseDeDatos: 'sin_conexion' });
    }
  });

  // Portal ciudadano (sin sesión).
  v1.use('/publico', rutasPublicas(servicios, limites, deps.tokens, deps.turnstile));

  // Reportes de entrega del proveedor de correo (RNF-13), protegidos con un secreto compartido.
  v1.post('/webhooks/correo', async (req, res) => {
    const recibido = Buffer.from(String(req.headers['x-webhook-secret'] ?? ''));
    const esperado = Buffer.from(env.mailWebhookSecret);
    if (recibido.length !== esperado.length || !timingSafeEqual(recibido, esperado)) {
      throw forbidden();
    }
    const d = webhookCorreoSchema.parse(req.body);
    const encontrado = await servicios.correos.registrarEventoEntrega(d);
    res
      .status(encontrado ? 200 : 404)
      .json(encontrado ? { ok: true } : cuerpoError('NO_ENCONTRADO', 'Correo no encontrado'));
  });

  // El portal interno y la API de administración pueden restringirse por IP.
  const soloRedInterna = restriccionIp(env.internalAllowedIps);
  v1.use('/auth', soloRedInterna, rutasAuth(servicios, limites, env, deps.turnstile));
  v1.use('/admin', soloRedInterna, rutasAdmin(servicios));

  if (env.apiDocs) publicarDocumentacion(app);

  app.use('/api/v1', v1);
  app.use(rutaNoEncontrada);
  app.use(manejadorErrores);
  return { app, servicios };
}
