import { createSecretKey, type KeyObject } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { unauthorized } from '../../shared/errors.js';

export interface TokenInterno {
  sub: number;
  /** Versión de token del usuario: cambia al modificar la contraseña o bloquearlo. */
  tv: number;
  /** El usuario debe cambiar su contraseña antes de usar el resto del sistema. */
  cambiarPassword: boolean;
  /** Identificador de la sesión (fila de `sesiones_internas`): permite cerrarla o revocarla al instante. */
  sid: string;
}

const AUD_INTERNO = 'interno';
const AUD_FORMULARIO = 'formulario-publico';
const AUD_CIUDADANO = 'ciudadano';
const ISSUER = 'estimulo-transporte';

export class TokenService {
  /**
   * La llave se convierte una sola vez. Si se entrega el texto, `jsonwebtoken` intenta leerlo como llave pública o
   * privada en cada firma y verificación, falla y recién entonces lo usa como secreto: bajo carga eso es una parte
   * importante del trabajo del servidor.
   */
  private readonly clave: KeyObject;

  constructor(secret: string) {
    this.clave = createSecretKey(Buffer.from(secret, 'utf8'));
  }

  /** Token de acceso: dura pocos minutos y se renueva con el refresh token (cookie HttpOnly). */
  firmarInterno(datos: TokenInterno, minutos: number): string {
    return jwt.sign({ tv: datos.tv, cp: datos.cambiarPassword, sid: datos.sid }, this.clave, {
      subject: String(datos.sub),
      audience: AUD_INTERNO,
      issuer: ISSUER,
      expiresIn: minutos * 60,
      algorithm: 'HS256',
    });
  }

  verificarInterno(token: string): TokenInterno {
    const p = this.verificar(token, AUD_INTERNO);
    return {
      sub: Number(p.sub),
      tv: Number(p.tv),
      cambiarPassword: p.cp === true,
      sid: typeof p.sid === 'string' ? p.sid : '',
    };
  }

  /**
   * Token del formulario público (control anti-automatización, RNF-04): guarda el instante en que se abrió el
   * formulario. Un envío casi instantáneo o muy tardío se rechaza.
   */
  firmarFormulario(abiertoEnMs: number, horas = 2): string {
    return jwt.sign({ t0: abiertoEnMs }, this.clave, {
      audience: AUD_FORMULARIO,
      issuer: ISSUER,
      expiresIn: horas * 3600,
      algorithm: 'HS256',
    });
  }

  /** Devuelve el instante de apertura, o null si el token no es válido o ya venció. */
  verificarFormulario(token: string): number | null {
    try {
      return Number(this.verificar(token, AUD_FORMULARIO).t0);
    } catch {
      return null;
    }
  }

  /** Sesión del ciudadano para consultar su solicitud: corta y limitada a esa solicitud. */
  firmarCiudadano(solicitudId: number, minutos: number): string {
    return jwt.sign({}, this.clave, {
      subject: String(solicitudId),
      audience: AUD_CIUDADANO,
      issuer: ISSUER,
      expiresIn: minutos * 60,
      algorithm: 'HS256',
    });
  }

  verificarCiudadano(token: string): number {
    return Number(this.verificar(token, AUD_CIUDADANO).sub);
  }

  private verificar(token: string, audience: string): jwt.JwtPayload {
    try {
      const payload = jwt.verify(token, this.clave, {
        audience,
        issuer: ISSUER,
        algorithms: ['HS256'],
      });
      if (typeof payload === 'string') throw new Error('payload');
      return payload;
    } catch (error) {
      const expirado = error instanceof jwt.TokenExpiredError;
      throw unauthorized(
        expirado ? 'La sesión expiró, inicie sesión de nuevo' : 'Sesión inválida',
        expirado ? 'SESION_EXPIRADA' : 'SESION_INVALIDA',
      );
    }
  }
}
