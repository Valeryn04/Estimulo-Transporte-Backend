import type { Env } from '../config/env.js';
import type { Pool } from '../infrastructure/db/pool.js';
import type { ConsultaRegimen } from '../infrastructure/bdua/regimen.js';
import type { Mailer } from '../infrastructure/mail/mailer.js';
import type { TokenService } from '../infrastructure/security/tokens.js';
import { forbidden } from '../shared/errors.js';

/** Dependencias de infraestructura que reciben los servicios de aplicación. */
export interface Dependencias {
  env: Env;
  pool: Pool;
  mailer: Mailer;
  tokens: TokenService;
  /** Consulta del régimen de salud (BDUA/ADRES). */
  regimen: ConsultaRegimen;
  /** Reloj inyectable para pruebas. */
  ahora: () => Date;
}

/** Usuario interno autenticado, con sus permisos ya resueltos desde la base de datos. */
export interface Actor {
  id: number;
  usuario: string;
  nombres: string;
  correo: string;
  roles: { id: number; codigo: string; nombre: string }[];
  permisos: ReadonlySet<string>;
}

export interface ContextoPeticion {
  ip: string | null;
}

export function exigirPermiso(actor: Actor, permiso: string): void {
  if (!actor.permisos.has(permiso)) throw forbidden();
}
