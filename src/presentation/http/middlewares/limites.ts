import { rateLimit } from 'express-rate-limit';
import { cuerpoError } from './errores.js';

function limitador(max: number, ventanaMinutos: number, mensaje: string) {
  return rateLimit({
    windowMs: ventanaMinutos * 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json(cuerpoError('DEMASIADOS_INTENTOS', mensaje));
    },
  });
}

/** Fábrica: en pruebas automáticas se desactivan los límites para no interferir entre casos. */
export function crearLimitadores(activos: boolean) {
  const sinLimite = () => (_req: unknown, _res: unknown, next: () => void) => next();
  if (!activos) {
    return {
      login: sinLimite(),
      refresco: sinLimite(),
      formulario: sinLimite(),
      preinscripcion: sinLimite(),
      verificacion: sinLimite(),
      reenvio: sinLimite(),
      codigo: sinLimite(),
      acceso: sinLimite(),
      caracterizacion: sinLimite(),
      documentos: sinLimite(),
    };
  }
  return {
    login: limitador(30, 15, 'Demasiados intentos de ingreso. Espere unos minutos.'),
    refresco: limitador(120, 15, 'Demasiadas renovaciones de sesión. Espere unos minutos.'),
    formulario: limitador(
      120,
      15,
      'Demasiadas solicitudes desde esta conexión. Espere unos minutos.',
    ),
    preinscripcion: limitador(
      10,
      60,
      'Demasiados envíos desde esta conexión. Intente de nuevo más tarde.',
    ),
    verificacion: limitador(30, 15, 'Demasiados intentos. Espere unos minutos e intente de nuevo.'),
    reenvio: limitador(5, 60, 'Solicitó el reenvío demasiadas veces. Intente de nuevo más tarde.'),
    codigo: limitador(
      10,
      60,
      'Solicitó demasiados códigos desde esta conexión. Intente de nuevo más tarde.',
    ),
    acceso: limitador(20, 15, 'Demasiados intentos. Espere unos minutos e intente de nuevo.'),
    // El avance se guarda solo mientras la persona escribe: se admite un ritmo alto.
    documentos: limitador(60, 15, 'Cargó demasiados documentos seguidos. Espere unos minutos.'),
    caracterizacion: limitador(600, 15, 'Demasiadas operaciones seguidas. Espere unos minutos.'),
  };
}

export type Limitadores = ReturnType<typeof crearLimitadores>;
