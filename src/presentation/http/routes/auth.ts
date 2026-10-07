import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../../../config/env.js';
import type { SesionIniciada } from '../../../application/autenticacion.js';
import type { Servicios } from '../../../container.js';
import { autenticarInterno } from '../middlewares/auth.js';
import type { Limitadores } from '../middlewares/limites.js';
import {
  COOKIE_REFRESH,
  borrarCookieRefresh,
  fijarCookieRefresh,
  leerCookie,
  soloDesdeElPortal,
} from '../cookies.js';
import { contexto } from '../utilidades.js';

const loginSchema = z.object({
  usuario: z
    .string({ error: 'Usuario: escriba su usuario' })
    .trim()
    .min(1, 'Usuario: escriba su usuario')
    .max(60),
  password: z.string({ error: 'Contraseña: escríbala' }).min(1, 'Contraseña: escríbala').max(128),
});

const cambioSchema = z.object({
  passwordActual: z
    .string({ error: 'Contraseña actual: escríbala' })
    .min(1, 'Contraseña actual: escríbala')
    .max(128),
  passwordNueva: z.string({ error: 'Nueva contraseña: escríbala' }).max(128),
});

/** Autenticación de usuarios internos (RF-ADM-01, RNF-05). */
export function rutasAuth(s: Servicios, limites: Limitadores, env: Env): Router {
  const r = Router();
  const desdePortal = soloDesdeElPortal(env);

  /** El refresh token va en la cookie HttpOnly y se quita del cuerpo: el navegador nunca lo ve en JavaScript. */
  const responder = (res: Response, resultado: SesionIniciada) => {
    const { refresh, ...cuerpo } = resultado;
    if (refresh) fijarCookieRefresh(res, refresh, env);
    res.json(cuerpo);
  };

  const sesionPermitiendoCambio = autenticarInterno(s.autenticacion, {
    permitirCambioPendiente: true,
  });

  r.post('/login', limites.login, async (req, res) => {
    const d = loginSchema.parse(req.body);
    responder(res, await s.autenticacion.login(d.usuario, d.password, contexto(req)));
  });

  // Renueva el token de acceso con la cookie HttpOnly. También restaura la sesión al recargar la página.
  r.post('/refresh', desdePortal, limites.refresco, async (req, res) => {
    responder(
      res,
      await s.autenticacion.renovarSesion(leerCookie(req, COOKIE_REFRESH), contexto(req)),
    );
  });

  r.post('/logout', desdePortal, async (req, res) => {
    await s.autenticacion.cerrarSesion(leerCookie(req, COOKIE_REFRESH), contexto(req));
    borrarCookieRefresh(res, env);
    res.status(204).end();
  });

  r.get('/me', sesionPermitiendoCambio, (req, res) => {
    res.json(s.autenticacion.perfil(req.actor!, req.debeCambiarPassword === true));
  });

  r.post('/cambiar-password', sesionPermitiendoCambio, async (req, res) => {
    const d = cambioSchema.parse(req.body);
    responder(
      res,
      await s.autenticacion.cambiarPassword(
        req.actor!,
        d.passwordActual,
        d.passwordNueva,
        contexto(req),
      ),
    );
  });

  return r;
}
