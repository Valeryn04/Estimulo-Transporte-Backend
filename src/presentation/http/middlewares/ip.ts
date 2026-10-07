import type { RequestHandler } from 'express';
import { forbidden } from '../../../shared/errors.js';

function ipv4ANumero(ip: string): number | null {
  const partes = ip.split('.').map(Number);
  if (partes.length !== 4 || partes.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return null;
  return (
    (((partes[0] as number) << 24) >>> 0) +
    ((partes[1] as number) << 16) +
    ((partes[2] as number) << 8) +
    (partes[3] as number)
  );
}

function normalizar(ip: string): string {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

/** Acepta IP exactas (IPv4/IPv6) y rangos CIDR IPv4 (por ejemplo 10.20.0.0/16). */
export function ipPermitida(ip: string, lista: string[]): boolean {
  const candidata = normalizar(ip);
  for (const regla of lista) {
    if (!regla.includes('/')) {
      if (normalizar(regla) === candidata) return true;
      continue;
    }
    const [base, bitsTexto] = regla.split('/') as [string, string];
    const bits = Number(bitsTexto);
    const a = ipv4ANumero(candidata);
    const b = ipv4ANumero(normalizar(base));
    if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((a & mascara) >>> 0 === (b & mascara) >>> 0) return true;
  }
  return false;
}

/**
 * RNF-08: restringe el portal interno a las IP o rangos autorizados por la Alcaldía.
 * Con la lista vacía la restricción está desactivada.
 */
export function restriccionIp(permitidas: string[]): RequestHandler {
  return (req, _res, next) => {
    if (permitidas.length === 0) return next();
    if (!ipPermitida(req.ip ?? '', permitidas)) {
      throw forbidden('Acceso no autorizado desde esta red', 'IP_NO_AUTORIZADA');
    }
    next();
  };
}
