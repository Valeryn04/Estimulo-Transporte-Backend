import type { Request, Response } from 'express';
import type { Env } from '../../config/env.js';
import { forbidden } from '../../shared/errors.js';

export const COOKIE_REFRESH = 'estimulo_rt';
/** Cabecera propia que solo el portal agrega: un formulario de otro sitio no puede enviarla. */
export const CABECERA_PORTAL = 'estimulo-portal';
/** La cookie solo se envía a las rutas de autenticación, no al resto de la API. */
const RUTA_COOKIE = '/api/v1/auth';

function opciones(env: Env) {
  return {
    httpOnly: true, // JavaScript no puede leerla: un XSS no puede robar el refresh token
    secure: env.cookieSecure,
    sameSite: 'strict' as const, // no se envía desde otros sitios (defensa contra CSRF)
    path: RUTA_COOKIE,
    // Sin «maxAge»: es una cookie de sesión del navegador y desaparece al cerrarlo.
  };
}

export function fijarCookieRefresh(res: Response, valor: string, env: Env): void {
  res.cookie(COOKIE_REFRESH, valor, opciones(env));
}

export function borrarCookieRefresh(res: Response, env: Env): void {
  res.clearCookie(COOKIE_REFRESH, opciones(env));
}

/** Lee una cookie sin depender de un analizador externo. */
export function leerCookie(req: Request, nombre: string): string | undefined {
  for (const par of (req.headers.cookie ?? '').split(';')) {
    const i = par.indexOf('=');
    if (i > 0 && par.slice(0, i).trim() === nombre) {
      try {
        return decodeURIComponent(par.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Defensa adicional contra CSRF en las rutas que usan la cookie: la petición debe venir del portal
 * (cabecera Origin igual a FRONTEND_URL cuando el navegador la envía) y llevar la cabecera propia.
 */
export function soloDesdeElPortal(env: Env) {
  return (req: Request, _res: Response, next: () => void) => {
    const origen = req.headers.origin;
    if (
      (origen && !env.frontendOrigenes.includes(origen)) ||
      req.headers['x-requested-with'] !== CABECERA_PORTAL
    ) {
      throw forbidden('Origen no permitido', 'ORIGEN_NO_PERMITIDO');
    }
    next();
  };
}
