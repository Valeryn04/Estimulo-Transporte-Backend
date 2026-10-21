import { memoriaPublica } from '../infrastructure/cache.js';
import { ACCION, MODULO } from '../domain/acciones.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { catalogosRepo } from '../infrastructure/repositories/catalogos.js';
import {
  autorizacionRepo,
  parametrosAdminRepo,
  vigenciasRepo,
  type Parametro,
} from '../infrastructure/repositories/parametrosAdmin.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';

/** Margen para aceptar «ahora» enviado por el navegador (reloj desfasado). */
const MARGEN_FECHA_PASADA_MS = 5 * 60_000;

function validarValor(
  p: Pick<Parametro, 'tipo' | 'minimo' | 'maximo' | 'patron'>,
  valor: string,
): string | null {
  if (p.tipo === 'ENTERO') {
    if (!/^-?\d+$/.test(valor)) return 'Valor: escriba un número entero';
    const n = Number(valor);
    if (p.minimo !== null && n < p.minimo) return `Valor: el mínimo permitido es ${p.minimo}`;
    if (p.maximo !== null && n > p.maximo) return `Valor: el máximo permitido es ${p.maximo}`;
  } else if (p.tipo === 'BOOLEANO') {
    if (valor !== 'true' && valor !== 'false') return 'Valor: use true o false';
  } else {
    if (valor.length === 0 || valor.length > 500) return 'Valor: escriba entre 1 y 500 caracteres';
    if (p.patron && !new RegExp(p.patron).test(valor)) {
      return 'Valor: el formato no es válido (por ejemplo: pdf,jpg,png)';
    }
  }
  return null;
}

/** Parámetros versionados, vigencias y cupos, y texto de autorización de datos (RF-ADM-02, RF-PRE-03). */
export class ServicioParametros {
  constructor(private readonly deps: Dependencias) {}

  listar() {
    return parametrosAdminRepo.listar(this.deps.pool);
  }

  async historial(clave: string) {
    if (!(await parametrosAdminRepo.definicion(this.deps.pool, clave))) {
      throw notFound('El parámetro no existe', 'PARAMETRO_NO_ENCONTRADO');
    }
    return parametrosAdminRepo.historial(this.deps.pool, clave);
  }

  /** Crea una versión nueva del parámetro: rige desde ahora o desde una fecha futura, con aprobador y motivo. */
  async nuevaVersion(
    actor: Actor,
    clave: string,
    d: { valor: string; vigenteDesde: string | null; justificacion: string },
    ctx: ContextoPeticion,
  ) {
    const def = await parametrosAdminRepo.definicion(this.deps.pool, clave);
    if (!def) throw notFound('El parámetro no existe', 'PARAMETRO_NO_ENCONTRADO');
    const valor = d.valor.trim();
    const error = validarValor(def, valor);
    if (error) throw errorValidacion([{ campo: 'valor', mensaje: error }]);
    let desde: Date | null = null;
    if (d.vigenteDesde) {
      desde = new Date(d.vigenteDesde);
      if (desde.getTime() < this.deps.ahora().getTime() - MARGEN_FECHA_PASADA_MS) {
        throw errorValidacion([
          { campo: 'vigenteDesde', mensaje: 'Vigente desde: no puede ser una fecha pasada' },
        ]);
      }
    }
    await withTransaction(this.deps.pool, async (tx) => {
      const actual = (await parametrosAdminRepo.listar(tx)).find(
        (p) => p.clave === clave,
      ) as Parametro;
      if (!desde && actual.vigente.valor === valor) {
        throw conflict('SIN_CAMBIO', 'El valor es igual al que está vigente');
      }
      await parametrosAdminRepo.crearVersion(tx, {
        clave,
        valor,
        vigenteDesde: desde,
        aprobadoPor: actor.id,
        justificacion: d.justificacion,
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PARAMETROS,
        accion: ACCION.PARAMETRO_VERSION_CREADA,
        entidad: 'parametro',
        entidadId: clave,
        valorAnterior: { valor: actual.vigente.valor },
        valorNuevo: { valor, vigenteDesde: desde?.toISOString() ?? 'inmediata' },
        justificacion: d.justificacion,
        ip: ctx.ip,
      });
    });
    return (await parametrosAdminRepo.listar(this.deps.pool)).find(
      (p) => p.clave === clave,
    ) as Parametro;
  }

  // ---------------------------------------------------------------- vigencias y cupos

  vigencias() {
    return vigenciasRepo.listar(this.deps.pool);
  }

  async versionesVigencia(id: number) {
    if (!(await vigenciasRepo.porId(this.deps.pool, id))) {
      throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
    }
    return catalogosRepo.versiones(this.deps.pool, 'vigencias', id);
  }

  private async validarFechas(
    db: Parameters<typeof vigenciasRepo.listar>[0],
    fechaInicio: string,
    fechaFin: string,
    excluirId?: number,
  ) {
    if (fechaFin < fechaInicio) {
      throw errorValidacion([
        { campo: 'fechaFin', mensaje: 'Fecha final: no puede ser anterior a la inicial' },
      ]);
    }
    const otras = (await vigenciasRepo.listar(db)).filter((v) => v.id !== excluirId);
    const cruzada = otras.find((v) => fechaInicio <= v.fechaFin && fechaFin >= v.fechaInicio);
    if (cruzada) {
      throw errorValidacion([
        { campo: 'fechaInicio', mensaje: `Fechas: se cruzan con la vigencia ${cruzada.anio}` },
      ]);
    }
  }

  async crearVigencia(
    actor: Actor,
    d: { anio: number; fechaInicio: string; fechaFin: string; cuposTotales: number },
    ctx: ContextoPeticion,
  ) {
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      await this.validarFechas(tx, d.fechaInicio, d.fechaFin);
      let nuevo: number;
      try {
        nuevo = await vigenciasRepo.crear(tx, d);
      } catch (error) {
        if ((error as { constraint?: string }).constraint === 'vigencias_anio_key') {
          throw errorValidacion([
            { campo: 'anio', mensaje: 'Año: ya existe una vigencia para ese año' },
          ]);
        }
        throw error;
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PARAMETROS,
        accion: ACCION.VIGENCIA_CREADA,
        entidad: 'vigencia',
        entidadId: nuevo,
        valorNuevo: d,
        ip: ctx.ip,
      });
      return nuevo;
    });
    return (await vigenciasRepo.porId(this.deps.pool, id)) as NonNullable<
      Awaited<ReturnType<typeof vigenciasRepo.porId>>
    >;
  }

  async actualizarVigencia(
    actor: Actor,
    id: number,
    d: { fechaInicio: string; fechaFin: string; cuposTotales: number },
    ctx: ContextoPeticion,
  ) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await vigenciasRepo.porId(tx, id);
      if (!actual) throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
      if (d.cuposTotales !== actual.cuposTotales) {
        // Los cupos y el presupuesto se modifican con su soporte desde «Cupos y presupuesto» (RF-ASI-01).
        throw errorValidacion([
          {
            campo: 'cuposTotales',
            mensaje:
              'Cupos: se modifican en «Cupos y presupuesto», donde queda registrado el motivo y el soporte del cambio',
          },
        ]);
      }
      await this.validarFechas(tx, d.fechaInicio, d.fechaFin, id);
      await vigenciasRepo.actualizar(tx, id, d);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PARAMETROS,
        accion: ACCION.VIGENCIA_MODIFICADA,
        entidad: 'vigencia',
        entidadId: id,
        valorAnterior: {
          fechaInicio: actual.fechaInicio,
          fechaFin: actual.fechaFin,
          cuposTotales: actual.cuposTotales,
        },
        valorNuevo: d,
        ip: ctx.ip,
      });
    });
    return (await vigenciasRepo.porId(this.deps.pool, id)) as NonNullable<
      Awaited<ReturnType<typeof vigenciasRepo.porId>>
    >;
  }

  /** Solo una vigencia está activa a la vez: la que recibe las preinscripciones. */
  async activarVigencia(actor: Actor, id: number, ctx: ContextoPeticion) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await vigenciasRepo.porId(tx, id);
      if (!actual) throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
      if (actual.activa) throw conflict('SIN_CAMBIO', 'La vigencia ya está activa');
      const anterior = (await vigenciasRepo.listar(tx)).find((v) => v.activa);
      await vigenciasRepo.activar(tx, id);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PARAMETROS,
        accion: ACCION.VIGENCIA_ACTIVADA,
        entidad: 'vigencia',
        entidadId: id,
        valorAnterior: { vigenciaActiva: anterior?.anio ?? null },
        valorNuevo: { vigenciaActiva: actual.anio },
        ip: ctx.ip,
      });
    });
    return (await vigenciasRepo.porId(this.deps.pool, id)) as NonNullable<
      Awaited<ReturnType<typeof vigenciasRepo.porId>>
    >;
  }

  // ---------------------------------------------------------------- texto de autorización (RF-PRE-03)

  async autorizacion() {
    const versiones = await autorizacionRepo.listar(this.deps.pool);
    return { vigente: versiones[0] ?? null, versiones };
  }

  /** Cada cambio genera una versión nueva; las aceptaciones anteriores conservan la que aceptaron. */
  async nuevaAutorizacion(actor: Actor, contenido: string, ctx: ContextoPeticion) {
    const texto = contenido.trim();
    const version = await withTransaction(this.deps.pool, async (tx) => {
      const actual = (await autorizacionRepo.listar(tx))[0];
      if (actual && actual.contenido.trim() === texto) {
        throw conflict('SIN_CAMBIO', 'El texto es igual al de la versión vigente');
      }
      const nueva = await autorizacionRepo.crear(tx, texto, actor.id);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.AUTORIZACION,
        accion: ACCION.AUTORIZACION_VERSION_CREADA,
        entidad: 'texto_autorizacion',
        entidadId: nueva,
        valorAnterior: { version: actual?.version ?? null },
        valorNuevo: { version: nueva, caracteres: texto.length },
        ip: ctx.ip,
      });
      return nueva;
    });
    memoriaPublica.invalidar();
    return { version };
  }
}
