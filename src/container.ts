import type { Env } from './config/env.js';
import type { Dependencias } from './application/contexto.js';
import { ServicioAsignacion } from './application/asignacion.js';
import { ServicioEntregas } from './application/entregas.js';
import { ServicioActualizaciones } from './application/actualizaciones.js';
import { ServicioEncuestas } from './application/encuestas.js';
import { crearConsultaRegimen } from './infrastructure/bdua/regimen.js';
import { crearTurnstile } from './infrastructure/security/turnstile.js';
import { ServicioSeguimiento } from './application/seguimiento.js';
import { ServicioNovedades } from './application/novedades.js';
import { ServicioAutenticacion } from './application/autenticacion.js';
import { ServicioCatalogos } from './application/catalogos.js';
import { ServicioCaracterizacion } from './application/caracterizacion.js';
import { ServicioCruces } from './application/cruces.js';
import { ServicioDocumentos } from './application/documentos.js';
import { ServicioRadicacion } from './application/radicacion.js';
import { ServicioConsulta } from './application/consulta.js';
import { ServicioCorreos } from './application/correos.js';
import { ServicioParametros } from './application/parametros.js';
import { ServicioPlantillas } from './application/plantillas.js';
import { ServicioMatriz } from './application/matriz.js';
import { ServicioPriorizacion } from './application/priorizacion.js';
import { ServicioPreinscripcion } from './application/preinscripcion.js';
import { ServicioRequisitos } from './application/requisitos.js';
import { ServicioRoles } from './application/roles.js';
import { ServicioSubsanacion } from './application/subsanacion.js';
import { ServicioValidacion } from './application/validacion.js';
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
  validacion: ServicioValidacion;
  requisitos: ServicioRequisitos;
  subsanacion: ServicioSubsanacion;
  cruces: ServicioCruces;
  matriz: ServicioMatriz;
  priorizacion: ServicioPriorizacion;
  asignacion: ServicioAsignacion;
  entregas: ServicioEntregas;
  novedades: ServicioNovedades;
  encuestas: ServicioEncuestas;
  actualizaciones: ServicioActualizaciones;
  seguimiento: ServicioSeguimiento;
}

export function crearDependencias(env: Env): Dependencias {
  return {
    env,
    pool: createPool(env.databaseUrl, env.dbPoolMax),
    mailer: new SmtpMailer({ ...env.smtp, from: env.mailFrom }),
    tokens: new TokenService(env.jwtSecret),
    turnstile: crearTurnstile(env.turnstile),
    regimen: crearConsultaRegimen(env.bdua, env.bduaSimulado),
    ahora: () => new Date(),
  };
}

export function crearServicios(deps: Dependencias): Servicios {
  const correos = new ServicioCorreos(deps);
  const documentos = new ServicioDocumentos(deps);
  const cruces = new ServicioCruces(deps);
  const priorizacion = new ServicioPriorizacion(deps, documentos);
  const asignacion = new ServicioAsignacion(deps, correos, documentos);
  const novedades = new ServicioNovedades(deps, correos, documentos, asignacion, cruces);
  const encuestas = new ServicioEncuestas(deps, correos);
  // Cada archivo de cruce cargado se compara con los beneficios vigentes (RF-NOV-03).
  cruces.alCargar = (estructura, cargaId, actorId) =>
    novedades.evaluarCarga(estructura, cargaId, actorId);
  return {
    autenticacion: new ServicioAutenticacion(deps),
    usuarios: new ServicioUsuarios(deps, correos),
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
    validacion: new ServicioValidacion(deps, correos, documentos, cruces, priorizacion),
    requisitos: new ServicioRequisitos(deps),
    subsanacion: new ServicioSubsanacion(deps, correos, documentos),
    cruces,
    matriz: new ServicioMatriz(deps, priorizacion),
    priorizacion,
    asignacion,
    entregas: new ServicioEntregas(deps, correos, documentos),
    novedades,
    encuestas,
    actualizaciones: new ServicioActualizaciones(deps, correos, documentos, asignacion),
    seguimiento: new ServicioSeguimiento(deps, encuestas, correos, documentos),
  };
}
