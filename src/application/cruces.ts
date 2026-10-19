import { createHmac } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import { interpretarCruce, normalizarIdentificacion } from '../domain/cruces.js';
import { codigoDesdeNombre } from '../domain/texto.js';
import { ARCHIVO_MAX_MB_ABSOLUTO } from '../domain/limites.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction, type Queryable } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { catalogosRepo } from '../infrastructure/repositories/catalogos.js';
import {
  crucesRepo,
  type DatosEstructura,
  type Estructura,
} from '../infrastructure/repositories/cruces.js';
import { sha256Hex } from '../infrastructure/security/crypto.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ArchivoEntrada } from './documentos.js';
import { errorValidacion } from './esquemas.js';

export interface AlertaCruce {
  cruceCodigo: string;
  nombre: string | null;
  /** Fecha de la carga contra la que se consultó; null si todavía no hay archivo cargado. */
  cargadoAt: string | null;
  coincidencias: { persona: 'PCD' | 'CUIDADOR'; detalle: string }[];
}

function traducirUnicidad(error: unknown): never {
  const e = error as { code?: string };
  if (e.code === '23505') {
    throw errorValidacion([
      { campo: 'nombre', mensaje: 'Nombre: ya existe una estructura de cruce con ese nombre' },
    ]);
  }
  throw error;
}

/**
 * Archivos de cruce (RF-ADM-05): estructura configurable, carga con reporte de errores y consulta de coincidencias
 * para las alertas de la validación (RF-VAL-03). Las identificaciones del archivo se guardan como huella (HMAC).
 */
export class ServicioCruces {
  constructor(private readonly deps: Dependencias) {}

  huella(identificacion: string): string {
    return createHmac('sha256', this.deps.env.jwtSecret)
      .update(`cruce:${normalizarIdentificacion(identificacion)}`)
      .digest('hex');
  }

  listar() {
    return crucesRepo.listar(this.deps.pool);
  }

  /** Estructuras activas que un requisito puede usar. */
  async opciones(): Promise<{ codigo: string; nombre: string }[]> {
    return (await crucesRepo.listar(this.deps.pool))
      .filter((e) => e.activo)
      .map((e) => ({ codigo: e.codigo, nombre: e.nombre }));
  }

  async versiones(id: number) {
    if (!(await crucesRepo.porId(this.deps.pool, id))) {
      throw notFound('La estructura de cruce no existe', 'CRUCE_NO_ENCONTRADO');
    }
    return catalogosRepo.versiones(this.deps.pool, 'cruce_estructuras', id);
  }

  async cargas(id: number) {
    if (!(await crucesRepo.porId(this.deps.pool, id))) {
      throw notFound('La estructura de cruce no existe', 'CRUCE_NO_ENCONTRADO');
    }
    return crucesRepo.cargas(this.deps.pool, id);
  }

  /** Reporte de errores de una carga, en CSV, para corregir el archivo y volver a cargarlo. */
  async reporteErrores(cargaId: number): Promise<{ nombre: string; contenido: Buffer }> {
    const carga = await crucesRepo.carga(this.deps.pool, cargaId);
    if (!carga) throw notFound('La carga no existe', 'CARGA_NO_ENCONTRADA');
    const filas = await crucesRepo.errores(this.deps.pool, cargaId);
    const csv = ['fila;error', ...filas.map((f) => `${f.fila};"${f.mensaje.replace(/"/g, '""')}"`)];
    return {
      nombre: `errores-carga-${cargaId}.csv`,
      contenido: Buffer.from(`\uFEFF${csv.join('\r\n')}\r\n`, 'utf8'),
    };
  }

  private validar(d: DatosEstructura): void {
    if (
      d.columnaDetalle !== null &&
      d.columnaDetalle.trim().toUpperCase() === d.columnaIdentificacion.trim().toUpperCase()
    ) {
      throw errorValidacion([
        {
          campo: 'columnaDetalle',
          mensaje: 'Columna de detalle: debe ser distinta de la columna de identificación',
        },
      ]);
    }
  }

  async crear(actor: Actor, d: DatosEstructura, ctx: ContextoPeticion): Promise<Estructura> {
    this.validar(d);
    const codigo = codigoDesdeNombre(d.nombre, '', 60);
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      let nuevo: number;
      try {
        nuevo = await crucesRepo.crear(tx, codigo, d);
      } catch (error) {
        traducirUnicidad(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CRUCES,
        accion: ACCION.CRUCE_ESTRUCTURA_CREADA,
        entidad: 'cruce',
        entidadId: nuevo,
        valorNuevo: { codigo, ...d },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return (await crucesRepo.porId(this.deps.pool, id)) as Estructura;
  }

  async actualizar(
    actor: Actor,
    id: number,
    d: DatosEstructura,
    ctx: ContextoPeticion,
  ): Promise<Estructura> {
    this.validar(d);
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await crucesRepo.porId(tx, id);
      if (!actual) throw notFound('La estructura de cruce no existe', 'CRUCE_NO_ENCONTRADO');
      try {
        await crucesRepo.actualizar(tx, id, d);
      } catch (error) {
        traducirUnicidad(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CRUCES,
        accion: ACCION.CRUCE_ESTRUCTURA_MODIFICADA,
        entidad: 'cruce',
        entidadId: id,
        valorAnterior: {
          nombre: actual.nombre,
          entidad: actual.entidad,
          descripcion: actual.descripcion,
          columnaIdentificacion: actual.columnaIdentificacion,
          columnaDetalle: actual.columnaDetalle,
          aplicaA: actual.aplicaA,
        },
        valorNuevo: d,
        ip: ctx.ip,
      });
    });
    return (await crucesRepo.porId(this.deps.pool, id)) as Estructura;
  }

  async cambiarActivo(
    actor: Actor,
    id: number,
    activo: boolean,
    ctx: ContextoPeticion,
  ): Promise<Estructura> {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await crucesRepo.porId(tx, id);
      if (!actual) throw notFound('La estructura de cruce no existe', 'CRUCE_NO_ENCONTRADO');
      if (actual.activo === activo) {
        throw conflict(
          'SIN_CAMBIO',
          activo ? 'La estructura ya está activa' : 'La estructura ya está inactiva',
        );
      }
      await crucesRepo.fijarActivo(tx, id, activo);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CRUCES,
        accion: activo ? ACCION.CRUCE_ESTRUCTURA_ACTIVADA : ACCION.CRUCE_ESTRUCTURA_DESACTIVADA,
        entidad: 'cruce',
        entidadId: id,
        valorAnterior: { activo: actual.activo },
        valorNuevo: { activo },
        ip: ctx.ip,
      });
    });
    return (await crucesRepo.porId(this.deps.pool, id)) as Estructura;
  }

  /**
   * Carga un archivo. Si le falta la columna de identificación se rechaza completo; si solo algunas filas fallan,
   * se cargan las válidas y se deja el reporte de errores para corregir el resto.
   */
  async cargar(actor: Actor, id: number, archivo: ArchivoEntrada, ctx: ContextoPeticion) {
    const estructura = await crucesRepo.porId(this.deps.pool, id);
    if (!estructura) throw notFound('La estructura de cruce no existe', 'CRUCE_NO_ENCONTRADO');
    if (!estructura.activo) {
      throw conflict(
        'CRUCE_INACTIVO',
        'La estructura está inactiva: actívela para cargar archivos',
      );
    }
    if (!/\.(csv|txt)$/i.test(archivo.nombre)) {
      throw errorValidacion([
        {
          campo: 'archivo',
          mensaje: 'Archivo: use un archivo CSV (.csv) con la primera fila de títulos',
        },
      ]);
    }
    if (archivo.contenido.length > ARCHIVO_MAX_MB_ABSOLUTO * 1_048_576) {
      throw errorValidacion([
        { campo: 'archivo', mensaje: `Archivo: pesa más de ${ARCHIVO_MAX_MB_ABSOLUTO} MB` },
      ]);
    }
    const lectura = interpretarCruce(
      archivo.contenido.toString('utf8'),
      estructura.columnaIdentificacion,
      estructura.columnaDetalle,
    );
    if ('error' in lectura) {
      throw errorValidacion([{ campo: 'archivo', mensaje: `Archivo: ${lectura.error}` }]);
    }
    if (lectura.registros.length === 0) {
      throw errorValidacion([
        {
          campo: 'archivo',
          mensaje: 'Archivo: no tiene ninguna fila válida. Revise las identificaciones.',
        },
      ]);
    }
    const cargaId = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const nueva = await crucesRepo.registrarCarga(tx, {
        estructuraId: id,
        archivoNombre: archivo.nombre.slice(0, 200),
        archivoHash: sha256Hex(archivo.contenido),
        total: lectura.total,
        huellas: lectura.registros.map((r) => ({
          huella: this.huella(r.identificacion),
          detalle: r.detalle,
        })),
        errores: lectura.errores,
        usuarioId: actor.id,
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.CRUCES,
        accion: ACCION.CRUCE_CARGADO,
        entidad: 'cruce',
        entidadId: id,
        detalle: {
          cargaId: nueva,
          archivo: archivo.nombre,
          filas: lectura.total,
          validas: lectura.registros.length,
          errores: lectura.errores.length,
        },
        ip: ctx.ip,
      });
      return nueva;
    });
    return (await crucesRepo.carga(this.deps.pool, cargaId)) as NonNullable<
      Awaited<ReturnType<typeof crucesRepo.carga>>
    >;
  }

  /**
   * Alertas de un caso (RF-VAL-03): para cada cruce que usa la lista de chequeo, ¿la persona con discapacidad o su
   * cuidador aparecen en el archivo vigente?
   */
  async alertas(
    db: Queryable,
    codigos: string[],
    personas: { pcd: string; cuidador: string },
  ): Promise<AlertaCruce[]> {
    const huellaPcd = this.huella(personas.pcd);
    const huellaCuidador = this.huella(personas.cuidador);
    const salida: AlertaCruce[] = [];
    for (const codigo of [...new Set(codigos)]) {
      const { estructura, coincidencias } = await crucesRepo.coincidencias(db, codigo, [
        huellaPcd,
        huellaCuidador,
      ]);
      const aplica = estructura?.aplicaA ?? 'AMBOS';
      salida.push({
        cruceCodigo: codigo,
        nombre: estructura?.nombre ?? null,
        cargadoAt: estructura?.vigente?.cargadoAt.toISOString() ?? null,
        coincidencias: coincidencias.flatMap((c) => {
          const out: AlertaCruce['coincidencias'] = [];
          if (c.huella === huellaPcd && aplica !== 'CUIDADOR')
            out.push({ persona: 'PCD', detalle: c.detalle });
          if (c.huella === huellaCuidador && aplica !== 'PCD')
            out.push({ persona: 'CUIDADOR', detalle: c.detalle });
          return out;
        }),
      });
    }
    return salida;
  }
}
