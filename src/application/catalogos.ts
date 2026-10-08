import { ACCION, MODULO } from '../domain/acciones.js';
import { codigoDesdeNombre } from '../domain/texto.js';
import { memoriaPublica } from '../infrastructure/cache.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import {
  catalogosRepo,
  documentosRepo,
  type AplicaA,
  type Catalogo,
  type DatosDocumento,
  type FiltroItems,
  type ItemCatalogo,
} from '../infrastructure/repositories/catalogos.js';
import { modelosRepo } from '../infrastructure/repositories/documentos.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

const PREFIJO: Partial<Record<Catalogo, string>> = { BARRIO: 'B_', LOCALIDAD: 'L_' };

/** Traduce las violaciones de unicidad y de integridad de PostgreSQL a errores de campo comprensibles. */
export function traducirErrorCatalogo(error: unknown, codigoAutomatico = false): never {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505') {
    if (e.constraint === 'uq_catalogo_nombre') {
      throw errorValidacion([{ campo: 'nombre', mensaje: 'Nombre: ya existe en esta lista' }]);
    }
    if (e.constraint === 'catalogo_items_catalogo_codigo_key' && codigoAutomatico) {
      throw errorValidacion([{ campo: 'nombre', mensaje: 'Nombre: ya existe en esta lista' }]);
    }
    if (e.constraint === 'catalogo_items_catalogo_codigo_key') {
      throw errorValidacion([{ campo: 'codigo', mensaje: 'Código: ya existe en esta lista' }]);
    }
    if (
      e.constraint === 'documentos_requeridos_codigo_key' ||
      e.constraint === 'uq_documento_nombre'
    ) {
      throw errorValidacion([
        { campo: 'nombre', mensaje: 'Nombre: ya existe un documento con ese nombre' },
      ]);
    }
  }
  if (
    e.code === '23505' &&
    (e.constraint === 'uq_catalogo_orden' || e.constraint === 'uq_documento_orden')
  ) {
    throw errorValidacion([
      {
        campo: 'orden',
        mensaje: 'Orden: otra persona acaba de usar esa posición, vuelva a intentarlo',
      },
    ]);
  }
  if (e.code === '23514' && e.message?.includes('localidad')) {
    throw errorValidacion([
      { campo: 'padreId', mensaje: 'Localidad: seleccione una localidad válida' },
    ]);
  }
  throw error;
}

export interface DatosItem {
  nombre: string;
  codigo?: string;
  padreId?: number | null;
  /** Posición en la lista (desde 1). Sin indicarla, queda al final o conserva la suya. */
  orden?: number;
}

/** Catálogos del programa y documentos exigidos (RF-ADM-02, RN-05, RN-06). */
export class ServicioCatalogos {
  constructor(private readonly deps: Dependencias) {}

  resumen() {
    return catalogosRepo.resumen(this.deps.pool);
  }

  listar(catalogo: Catalogo, filtro: FiltroItems) {
    return catalogosRepo.listar(this.deps.pool, catalogo, filtro);
  }

  async versiones(id: number) {
    if (!(await catalogosRepo.porId(this.deps.pool, id))) {
      throw notFound('El elemento no existe', 'ITEM_NO_ENCONTRADO');
    }
    return catalogosRepo.versiones(this.deps.pool, 'catalogo_items', id);
  }

  private async validarPadre(
    db: Parameters<typeof catalogosRepo.porId>[0],
    catalogo: Catalogo,
    padreId: number | null | undefined,
  ) {
    if (catalogo === 'BARRIO') {
      if (!padreId) {
        throw errorValidacion([
          { campo: 'padreId', mensaje: 'Localidad: seleccione la localidad del barrio' },
        ]);
      }
      const padre = await catalogosRepo.porId(db, padreId);
      if (!padre || padre.catalogo !== 'LOCALIDAD' || !padre.activo) {
        throw errorValidacion([
          { campo: 'padreId', mensaje: 'Localidad: seleccione una localidad activa' },
        ]);
      }
      return padreId;
    }
    return null;
  }

  async crear(
    actor: Actor,
    catalogo: Catalogo,
    d: DatosItem,
    ctx: ContextoPeticion,
  ): Promise<ItemCatalogo> {
    if (catalogo === 'TIPO_IDENTIFICACION' && !d.codigo) {
      throw errorValidacion([
        { campo: 'codigo', mensaje: 'Código: escriba la sigla del tipo de identificación' },
      ]);
    }
    const codigo = d.codigo ?? codigoDesdeNombre(d.nombre, PREFIJO[catalogo] ?? '');
    if (!/^[A-Z0-9_]{1,40}$/.test(codigo)) {
      throw errorValidacion([
        { campo: 'codigo', mensaje: 'Código: use solo letras, números y guion bajo' },
      ]);
    }
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const padreId = await this.validarPadre(tx, catalogo, d.padreId);
      let nuevo: number;
      try {
        nuevo = await catalogosRepo.crear(tx, {
          catalogo,
          codigo,
          nombre: d.nombre,
          padreId,
          orden: d.orden,
        });
      } catch (error) {
        traducirErrorCatalogo(error, !d.codigo);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CATALOGOS,
        accion: ACCION.CATALOGO_CREADO,
        entidad: catalogo,
        entidadId: nuevo,
        valorNuevo: {
          codigo,
          nombre: d.nombre,
          padreId,
          orden: (await catalogosRepo.porId(tx, nuevo))?.orden,
        },
        ip: ctx.ip,
      });
      return nuevo;
    });
    memoriaPublica.invalidar();
    return (await catalogosRepo.porId(this.deps.pool, id)) as ItemCatalogo;
  }

  async actualizar(
    actor: Actor,
    id: number,
    d: DatosItem,
    ctx: ContextoPeticion,
  ): Promise<ItemCatalogo> {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await catalogosRepo.porId(tx, id);
      if (!actual) throw notFound('El elemento no existe', 'ITEM_NO_ENCONTRADO');
      const padreId = await this.validarPadre(tx, actual.catalogo, d.padreId);
      try {
        await catalogosRepo.actualizar(
          tx,
          id,
          { nombre: d.nombre, padreId, orden: d.orden },
          { catalogo: actual.catalogo, padreId: actual.padreId },
        );
      } catch (error) {
        traducirErrorCatalogo(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CATALOGOS,
        accion: ACCION.CATALOGO_MODIFICADO,
        entidad: actual.catalogo,
        entidadId: id,
        valorAnterior: { nombre: actual.nombre, padreId: actual.padreId, orden: actual.orden },
        valorNuevo: {
          nombre: d.nombre,
          padreId,
          orden: (await catalogosRepo.porId(tx, id))?.orden,
        },
        ip: ctx.ip,
      });
    });
    memoriaPublica.invalidar();
    return (await catalogosRepo.porId(this.deps.pool, id)) as ItemCatalogo;
  }

  async cambiarActivo(
    actor: Actor,
    id: number,
    activo: boolean,
    ctx: ContextoPeticion,
  ): Promise<ItemCatalogo> {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await catalogosRepo.porId(tx, id);
      if (!actual) throw notFound('El elemento no existe', 'ITEM_NO_ENCONTRADO');
      if (actual.activo === activo) {
        throw conflict(
          'SIN_CAMBIO',
          activo ? 'El elemento ya está activo' : 'El elemento ya está inactivo',
        );
      }
      if (!activo && (await catalogosRepo.contarHijosActivos(tx, id)) > 0) {
        throw conflict(
          'TIENE_BARRIOS_ACTIVOS',
          'La localidad tiene barrios activos: desactívelos o cámbielos de localidad primero',
        );
      }
      if (activo && actual.padreId) {
        const padre = await catalogosRepo.porId(tx, actual.padreId);
        if (!padre?.activo) {
          throw conflict(
            'LOCALIDAD_INACTIVA',
            'No se puede activar un barrio cuya localidad está inactiva',
          );
        }
      }
      await catalogosRepo.fijarActivo(tx, id, activo);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CATALOGOS,
        accion: activo ? ACCION.CATALOGO_ACTIVADO : ACCION.CATALOGO_DESACTIVADO,
        entidad: actual.catalogo,
        entidadId: id,
        valorAnterior: { activo: actual.activo },
        valorNuevo: { activo },
        ip: ctx.ip,
      });
    });
    memoriaPublica.invalidar();
    return (await catalogosRepo.porId(this.deps.pool, id)) as ItemCatalogo;
  }

  // ---------------------------------------------------------------- documentos exigidos

  /** Documentos exigidos, cada uno con el modelo descargable que publicó la Gerencia (si lo hay). */
  async documentos() {
    const [docs, modelos] = await Promise.all([
      documentosRepo.listar(this.deps.pool),
      modelosRepo.resumenes(this.deps.pool),
    ]);
    return docs.map((d) => ({ ...d, modelo: modelos.get(d.id) ?? null }));
  }

  async versionesDocumento(id: number) {
    if (!(await documentosRepo.porId(this.deps.pool, id))) {
      throw notFound('El documento no existe', 'DOCUMENTO_NO_ENCONTRADO');
    }
    return catalogosRepo.versiones(this.deps.pool, 'documentos_requeridos', id);
  }

  async crearDocumento(actor: Actor, d: DatosDocumento, ctx: ContextoPeticion) {
    const codigo = codigoDesdeNombre(d.nombre, `${d.aplicaA}_`, 60);
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      let nuevo: number;
      try {
        nuevo = await documentosRepo.crear(tx, codigo, d);
      } catch (error) {
        traducirErrorCatalogo(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CATALOGOS,
        accion: ACCION.DOCUMENTO_REQUERIDO_CREADO,
        entidad: 'documento_requerido',
        entidadId: nuevo,
        valorNuevo: { codigo, ...d, orden: (await documentosRepo.porId(tx, nuevo))?.orden },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return (await documentosRepo.porId(this.deps.pool, id)) as NonNullable<
      Awaited<ReturnType<typeof documentosRepo.porId>>
    >;
  }

  async actualizarDocumento(actor: Actor, id: number, d: DatosDocumento, ctx: ContextoPeticion) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await documentosRepo.porId(tx, id);
      if (!actual) throw notFound('El documento no existe', 'DOCUMENTO_NO_ENCONTRADO');
      try {
        await documentosRepo.actualizar(tx, id, d);
      } catch (error) {
        traducirErrorCatalogo(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CATALOGOS,
        accion: ACCION.DOCUMENTO_REQUERIDO_MODIFICADO,
        entidad: 'documento_requerido',
        entidadId: id,
        valorAnterior: {
          nombre: actual.nombre,
          descripcion: actual.descripcion,
          aplicaA: actual.aplicaA as AplicaA,
          obligatorio: actual.obligatorio,
          orden: actual.orden,
        },
        valorNuevo: { ...d, orden: (await documentosRepo.porId(tx, id))?.orden },
        ip: ctx.ip,
      });
    });
    return (await documentosRepo.porId(this.deps.pool, id)) as NonNullable<
      Awaited<ReturnType<typeof documentosRepo.porId>>
    >;
  }

  async cambiarActivoDocumento(actor: Actor, id: number, activo: boolean, ctx: ContextoPeticion) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await documentosRepo.porId(tx, id);
      if (!actual) throw notFound('El documento no existe', 'DOCUMENTO_NO_ENCONTRADO');
      if (actual.activo === activo) {
        throw conflict(
          'SIN_CAMBIO',
          activo ? 'El documento ya está activo' : 'El documento ya está inactivo',
        );
      }
      await documentosRepo.fijarActivo(tx, id, activo);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CATALOGOS,
        accion: activo
          ? ACCION.DOCUMENTO_REQUERIDO_ACTIVADO
          : ACCION.DOCUMENTO_REQUERIDO_DESACTIVADO,
        entidad: 'documento_requerido',
        entidadId: id,
        valorAnterior: { activo: actual.activo },
        valorNuevo: { activo },
        ip: ctx.ip,
      });
    });
    return (await documentosRepo.porId(this.deps.pool, id)) as NonNullable<
      Awaited<ReturnType<typeof documentosRepo.porId>>
    >;
  }
}
