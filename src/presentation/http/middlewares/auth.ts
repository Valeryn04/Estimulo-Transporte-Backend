import type { Request, RequestHandler } from 'express';
import type { ServicioAutenticacion } from '../../../application/autenticacion.js';
import type { Actor } from '../../../application/contexto.js';
import type { TokenService } from '../../../infrastructure/security/tokens.js';
import { forbidden, unauthorized } from '../../../shared/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      debeCambiarPassword?: boolean;
      /** Solicitud a la que el ciudadano validó su acceso (consulta de estado). */
      solicitudId?: number;
    }
  }
}

function bearer(req: Request): string {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) throw unauthorized();
  return h.slice(7).trim();
}

/**
 * Autentica al usuario interno. Los permisos se leen de la base de datos en cada petición, de modo que
 * un cambio de rol, de vigencia o un bloqueo se aplica de inmediato, también contra llamadas directas a la API.
 */
export function autenticarInterno(
  autenticacion: ServicioAutenticacion,
  opciones: { permitirCambioPendiente?: boolean } = {},
): RequestHandler {
  return async (req, _res, next) => {
    const { actor, cambiarPassword } = await autenticacion.autenticar(bearer(req));
    if (cambiarPassword && !opciones.permitirCambioPendiente) {
      throw forbidden('Debe cambiar su contraseña para continuar', 'PASSWORD_VENCIDA');
    }
    req.actor = actor;
    req.debeCambiarPassword = cambiarPassword;
    next();
  };
}

/** El usuario debe tener TODOS los permisos indicados. */
export function requierePermisos(...permisos: string[]): RequestHandler {
  return (req, _res, next) => {
    const actor = req.actor;
    if (!actor) throw unauthorized();
    if (!permisos.every((p) => actor.permisos.has(p))) throw forbidden();
    next();
  };
}

/** Basta con tener uno de los permisos (por ejemplo, quien configura y quien aprueba pueden ver lo mismo). */
export function requiereAlguno(...permisos: string[]): RequestHandler {
  return (req, _res, next) => {
    const actor = req.actor;
    if (!actor) throw unauthorized();
    if (!permisos.some((p) => actor.permisos.has(p))) throw forbidden();
    next();
  };
}

/** Sesión del ciudadano para consultar su solicitud: limitada a esa solicitud y de corta duración. */
export function autenticarCiudadano(tokens: TokenService): RequestHandler {
  return (req, _res, next) => {
    req.solicitudId = tokens.verificarCiudadano(bearer(req));
    next();
  };
}
