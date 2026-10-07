import type { Env } from './config/env.js';
import type { Dependencias } from './application/contexto.js';
import { ServicioAutenticacion } from './application/autenticacion.js';
import { ServicioCatalogos } from './application/catalogos.js';
import { ServicioCaracterizacion } from './application/caracterizacion.js';
import { ServicioDocumentos } from './application/documentos.js';
import { ServicioRadicacion } from './application/radicacion.js';
import { ServicioConsulta } from './application/consulta.js';
import { ServicioCorreos } from './application/correos.js';
import { ServicioParametros } from './application/parametros.js';
import { ServicioPlantillas } from './application/plantillas.js';
import { ServicioPreinscripcion } from './application/preinscripcion.js';
import { ServicioRoles } from './application/roles.js';
import { ServicioUsuarios } from './application/usuarios.js';
import { createPool } from './infrastructure/db/pool.js';
import { SmtpMailer } from './infrastructure/mail/mailer.js';
import { TokenService } from './infrastructure/security/tokens.js';

/** Servicios de aplicación. Se irán agregando por módulo (preinscripción, caracterización, ...). */
export interface Servicios {
  autenticacion: ServicioAutenticacion;
  usuarios: ServicioUsuarios;
  roles: ServicioRoles;
  catalogos: ServicioCatalogos;
  parametros: ServicioParametros;
  plantillas: ServicioPlantillas;
  correos: ServicioCorreos;
  preinscripcion: ServicioPreinscripcion;
  consulta: ServicioConsulta;
  caracterizacion: ServicioCaracterizacion;
  documentos: ServicioDocumentos;
  radicacion: ServicioRadicacion;
}

export function crearDependencias(env: Env): Dependencias {
  return {
    env,
    pool: createPool(env.databaseUrl, env.dbPoolMax),
    mailer: new SmtpMailer({ ...env.smtp, from: env.mailFrom }),
    tokens: new TokenService(env.jwtSecret),
    ahora: () => new Date(),
  };
}

export function crearServicios(deps: Dependencias): Servicios {
  const correos = new ServicioCorreos(deps);
  const documentos = new ServicioDocumentos(deps);
  return {
    autenticacion: new ServicioAutenticacion(deps),
    usuarios: new ServicioUsuarios(deps),
    roles: new ServicioRoles(deps),
    catalogos: new ServicioCatalogos(deps),
    parametros: new ServicioParametros(deps),
    plantillas: new ServicioPlantillas(deps),
    correos,
    preinscripcion: new ServicioPreinscripcion(deps, correos),
    consulta: new ServicioConsulta(deps, correos),
    caracterizacion: new ServicioCaracterizacion(deps),
    documentos,
    radicacion: new ServicioRadicacion(deps, correos, documentos),
  };
}
