import type { RequestHandler } from 'express';
import { AppError } from '../../shared/errors.js';

/** Verificación anti-automatización (Cloudflare Turnstile) de los formularios públicos y del inicio de sesión. */
export interface VerificadorTurnstile {
  /** Sin llaves configuradas la verificación queda desactivada (desarrollo y pruebas). */
  readonly activo: boolean;
  readonly siteKey: string | null;
  verificar(token: string, ip: string | null): Promise<boolean>;
}

const URL_VERIFICACION = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export class CloudflareTurnstile implements VerificadorTurnstile {
  readonly activo = true;

  constructor(
    readonly siteKey: string,
    private readonly secreto: string,
    private readonly peticion: typeof fetch = fetch,
  ) {}

  async verificar(token: string, ip: string | null): Promise<boolean> {
    const cuerpo = new URLSearchParams({ secret: this.secreto, response: token });
    if (ip) cuerpo.set('remoteip', ip);
    try {
      const r = await this.peticion(URL_VERIFICACION, {
        method: 'POST',
        body: cuerpo,
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) return false;
      return ((await r.json()) as { success?: boolean }).success === true;
    } catch {
      // Si Cloudflare no responde no se deja pasar: el formulario público es el objetivo de la automatización.
      return false;
    }
  }
}

export class TurnstileDesactivado implements VerificadorTurnstile {
  readonly activo = false;
  readonly siteKey = null;
  async verificar(): Promise<boolean> {
    return true;
  }
}

export function crearTurnstile(
  config: { siteKey: string; secret: string } | null,
): VerificadorTurnstile {
  return config
    ? new CloudflareTurnstile(config.siteKey, config.secret)
    : new TurnstileDesactivado();
}

/** Exige el token del widget en la cabecera `X-Turnstile-Token` cuando la verificación está activa. */
export function exigirTurnstile(v: VerificadorTurnstile): RequestHandler {
  return async (req, _res, next) => {
    if (!v.activo) return next();
    const token = req.get('x-turnstile-token');
    if (!token || token.length > 2048 || !(await v.verificar(token, req.ip ?? null))) {
      return next(
        new AppError(
          422,
          'VERIFICACION_ROBOT',
          'No pudimos confirmar que es una persona. Marque la verificación e intente de nuevo.',
        ),
      );
    }
    next();
  };
}
