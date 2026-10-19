import { ACCION, MODULO } from '../domain/acciones.js';
import { CAMPOS } from '../domain/caracterizacion.js';
import { codigoDesdeNombre } from '../domain/texto.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { catalogosRepo } from '../infrastructure/repositories/catalogos.js';
import {
  requisitosRepo,
  type DatosRequisito,
  type Requisito,
} from '../infrastructure/repositories/requisitos.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

/** Los cruces con archivos que existen hoy (se amplían con la configuración de cargas de cruce). */
export const CRUCES_DISPONIBLES = ['BENEFICIOS_INCOMPATIBLES'] as const;

function traducirUnicidad(error: unknown): never {
  const e = error as { code?: string; constraint?: string };
  if (e.code === '23505') {
    throw errorValidacion([
      {
        campo: 'nombre',
        mensaje: 'Nombre: ya existe un requisito con ese nombre para esa persona',
      },
    ]);
  }
  throw error;
}

/**
 * Lista de chequeo parametrizable (RN-05, RF-ADM-04): los requisitos que el validador revisa en cada caso. Cada
 * cambio queda versionado; los casos que ya empezaron conservan la copia con la que se tramitaron.
 */
export class ServicioRequisitos {
  constructor(private readonly deps: Dependencias) {}

  listar() {
    return requisitosRepo.listar(this.deps.pool);
  }

  async versiones(id: number) {
    if (!(await requisitosRepo.porId(this.deps.pool, id))) {
      throw notFound('El requisito no existe', 'REQUISITO_NO_ENCONTRADO');
    }
    return catalogosRepo.versiones(this.deps.pool, 'requisitos_validacion', id);
  }

  private async validar(db: Parameters<typeof requisitosRepo.porId>[0], d: DatosRequisito) {
    const errores: { campo: string; mensaje: string }[] = [];
    const desconocidos = d.campos.filter((c) => !(CAMPOS as readonly string[]).includes(c));
    if (desconocidos.length > 0) {
      errores.push({ campo: 'campos', mensaje: `Datos: no existen ${desconocidos.join(', ')}` });
    }
    if (d.documentoId !== null && !(await requisitosRepo.documentoExiste(db, d.documentoId))) {
      errores.push({ campo: 'documentoId', mensaje: 'Documento: elija un documento de la lista' });
    }
    if (
      d.cruceCodigo !== null &&
      !(CRUCES_DISPONIBLES as readonly string[]).includes(d.cruceCodigo)
    ) {
      errores.push({ campo: 'cruceCodigo', mensaje: 'Cruce: elija un cruce de la lista' });
    }
    if (errores.length > 0) throw errorValidacion(errores);
  }

  async crear(actor: Actor, d: DatosRequisito, ctx: ContextoPeticion): Promise<Requisito> {
    const codigo = codigoDesdeNombre(d.nombre, `${d.aplicaA === 'COMUN' ? 'COM' : d.aplicaA}_`, 60);
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      await this.validar(tx, d);
      let nuevo: number;
      try {
        nuevo = await requisitosRepo.crear(tx, codigo, d);
      } catch (error) {
        traducirUnicidad(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.REQUISITOS,
        accion: ACCION.REQUISITO_CREADO,
        entidad: 'requisito',
        entidadId: nuevo,
        valorNuevo: { codigo, ...d },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return (await requisitosRepo.porId(this.deps.pool, id)) as Requisito;
  }

  async actualizar(
    actor: Actor,
    id: number,
    d: DatosRequisito,
    ctx: ContextoPeticion,
  ): Promise<Requisito> {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await requisitosRepo.porId(tx, id);
      if (!actual) throw notFound('El requisito no existe', 'REQUISITO_NO_ENCONTRADO');
      await this.validar(tx, d);
      try {
        await requisitosRepo.actualizar(tx, id, d);
      } catch (error) {
        traducirUnicidad(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.REQUISITOS,
        accion: ACCION.REQUISITO_MODIFICADO,
        entidad: 'requisito',
        entidadId: id,
        valorAnterior: {
          nombre: actual.nombre,
          descripcion: actual.descripcion,
          aplicaA: actual.aplicaA,
          fuenteSugerida: actual.fuenteSugerida,
          documentoId: actual.documentoId,
          campos: actual.campos,
          cruceCodigo: actual.cruceCodigo,
        },
        valorNuevo: d,
        ip: ctx.ip,
      });
    });
    return (await requisitosRepo.porId(this.deps.pool, id)) as Requisito;
  }

  async cambiarActivo(
    actor: Actor,
    id: number,
    activo: boolean,
    ctx: ContextoPeticion,
  ): Promise<Requisito> {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await requisitosRepo.porId(tx, id);
      if (!actual) throw notFound('El requisito no existe', 'REQUISITO_NO_ENCONTRADO');
      if (actual.activo === activo) {
        throw conflict(
          'SIN_CAMBIO',
          activo ? 'El requisito ya está activo' : 'El requisito ya está inactivo',
        );
      }
      await requisitosRepo.fijarActivo(tx, id, activo);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.REQUISITOS,
        accion: activo ? ACCION.REQUISITO_ACTIVADO : ACCION.REQUISITO_DESACTIVADO,
        entidad: 'requisito',
        entidadId: id,
        valorAnterior: { activo: actual.activo },
        valorNuevo: { activo },
        ip: ctx.ip,
      });
    });
    return (await requisitosRepo.porId(this.deps.pool, id)) as Requisito;
  }
}
