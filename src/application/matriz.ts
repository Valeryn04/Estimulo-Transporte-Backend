import { ACCION, MODULO } from '../domain/acciones.js';
import {
  calcularPuntaje,
  describirCriterio,
  erroresDeMatriz,
  ordenarPorPrioridad,
  puntajeMaximo,
  type DefinicionMatriz,
} from '../domain/priorizacion.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import {
  calculosRepo,
  matricesRepo,
  type Matriz,
} from '../infrastructure/repositories/priorizacion.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import { errorValidacion } from './esquemas.js';
import type { ServicioPriorizacion } from './priorizacion.js';

/** Resultados que se devuelven en una simulación (los primeros por posición simulada). */
const MAX_FILAS_SIMULACION = 300;

const vistaMatriz = (m: Matriz) => ({
  id: m.id,
  version: m.version,
  estado: m.estado,
  notas: m.notas,
  desempate: m.desempate,
  desempateTexto: m.desempate.map((c) => describirCriterio(c, m.variables)),
  puntajeMaximo: puntajeMaximo(m.variables),
  variables: m.variables,
  creadaPor: m.creadaPor,
  creadaAt: m.creadaAt.toISOString(),
  solicitadaPor: m.solicitadaPor,
  solicitadaAt: m.solicitadaAt?.toISOString() ?? null,
  decididaPor: m.decididaPor,
  decididaAt: m.decididaAt?.toISOString() ?? null,
  motivoDecision: m.motivoDecision,
  vigenteDesde: m.vigenteDesde?.toISOString() ?? null,
  vigenteHasta: m.vigenteHasta?.toISOString() ?? null,
});

/**
 * Matriz de ponderación versionada (RF-PRI-02, RF-ADM-04). Una versión se edita mientras es borrador; para usarla se
 * simula su efecto y la aprueba el responsable del proceso, que no puede ser quien la pidió. Al aprobarse queda
 * vigente; los cálculos anteriores conservan la versión con la que se hicieron.
 */
export class ServicioMatriz {
  constructor(
    private readonly deps: Dependencias,
    private readonly priorizacion: ServicioPriorizacion,
  ) {}

  async listar() {
    const lista = await matricesRepo.listar(this.deps.pool);
    return lista.map((m) => ({
      id: m.id,
      version: m.version,
      estado: m.estado,
      notas: m.notas,
      creadaPor: m.creadaPor,
      creadaAt: m.creadaAt.toISOString(),
      solicitadaPor: m.solicitadaPor,
      decididaPor: m.decididaPor,
      decididaAt: m.decididaAt?.toISOString() ?? null,
      motivoDecision: m.motivoDecision,
      vigenteDesde: m.vigenteDesde?.toISOString() ?? null,
      vigenteHasta: m.vigenteHasta?.toISOString() ?? null,
    }));
  }

  async obtener(id: number) {
    const m = await matricesRepo.porId(this.deps.pool, id);
    if (!m) throw notFound('La versión de la matriz no existe', 'MATRIZ_NO_ENCONTRADA');
    return vistaMatriz(m);
  }

  private validar(d: DefinicionMatriz): void {
    const errores = erroresDeMatriz(d);
    if (errores.length > 0) throw errorValidacion(errores);
  }

  private traducir(error: unknown): never {
    const e = error as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'uq_matriz_abierta') {
      throw conflict(
        'MATRIZ_ABIERTA',
        'Ya hay una versión en construcción o pendiente de aprobación. Termínela o recházela antes de crear otra.',
      );
    }
    throw error;
  }

  /** Crea un borrador: copia de la versión indicada (por defecto, la vigente) o con el contenido enviado. */
  async crearBorrador(
    actor: Actor,
    entrada: { desdeId?: number; definicion?: DefinicionMatriz },
    ctx: ContextoPeticion,
  ) {
    const id = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      let def = entrada.definicion;
      let origen: number | null = null;
      if (!def) {
        const base = entrada.desdeId
          ? await matricesRepo.porId(tx, entrada.desdeId)
          : await matricesRepo.vigente(tx);
        if (!base) throw notFound('La versión de la matriz no existe', 'MATRIZ_NO_ENCONTRADA');
        def = { notas: '', desempate: base.desempate, variables: base.variables };
        origen = base.version;
      }
      this.validar(def);
      let nuevo: number;
      try {
        nuevo = await matricesRepo.crearBorrador(tx, actor.id, def);
      } catch (error) {
        this.traducir(error);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PRIORIZACION,
        accion: ACCION.MATRIZ_CREADA,
        entidad: 'matriz',
        entidadId: nuevo,
        detalle: { copiaDeVersion: origen },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return this.obtener(id);
  }

  async actualizar(actor: Actor, id: number, d: DefinicionMatriz, ctx: ContextoPeticion) {
    this.validar(d);
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await matricesRepo.porId(tx, id);
      if (!actual) throw notFound('La versión de la matriz no existe', 'MATRIZ_NO_ENCONTRADA');
      if (actual.estado !== 'BORRADOR') {
        throw conflict(
          'MATRIZ_NO_EDITABLE',
          'Solo se puede modificar una versión en borrador. Cree una versión nueva para hacer cambios.',
        );
      }
      await matricesRepo.reemplazar(tx, id, d);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PRIORIZACION,
        accion: ACCION.MATRIZ_MODIFICADA,
        entidad: 'matriz',
        entidadId: id,
        valorAnterior: { variables: actual.variables, desempate: actual.desempate },
        valorNuevo: { variables: d.variables, desempate: d.desempate },
        ip: ctx.ip,
      });
    });
    return this.obtener(id);
  }

  async solicitarAprobacion(actor: Actor, id: number, ctx: ContextoPeticion) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const m = await matricesRepo.porId(tx, id);
      if (!m) throw notFound('La versión de la matriz no existe', 'MATRIZ_NO_ENCONTRADA');
      if (m.estado !== 'BORRADOR') {
        throw conflict(
          'MATRIZ_NO_EN_BORRADOR',
          'Solo se pide aprobación de una versión en borrador.',
        );
      }
      this.validar(m);
      await matricesRepo.solicitarAprobacion(tx, id, actor.id);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PRIORIZACION,
        accion: ACCION.MATRIZ_SOLICITADA,
        entidad: 'matriz',
        entidadId: id,
        ip: ctx.ip,
      });
    });
    return this.obtener(id);
  }

  /** El responsable aprueba (la versión queda vigente) o rechaza (con motivo). */
  async decidir(
    actor: Actor,
    id: number,
    d: { decision: 'APROBAR' | 'RECHAZAR'; motivo: string },
    ctx: ContextoPeticion,
  ) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const m = await matricesRepo.porId(tx, id);
      if (!m) throw notFound('La versión de la matriz no existe', 'MATRIZ_NO_ENCONTRADA');
      if (m.estado !== 'EN_APROBACION') {
        throw conflict('MATRIZ_NO_PENDIENTE', 'Esta versión no está pendiente de aprobación.');
      }
      if (m.solicitadaPorId === actor.id) {
        throw conflict(
          'MISMA_PERSONA',
          'La versión debe aprobarla alguien distinto de quien pidió la aprobación.',
        );
      }
      if (d.decision === 'RECHAZAR' && d.motivo.trim().length < 5) {
        throw errorValidacion([
          { campo: 'motivo', mensaje: 'Motivo: explique por qué se rechaza (mínimo 5 caracteres)' },
        ]);
      }
      if (d.decision === 'APROBAR') await matricesRepo.activar(tx, id, actor.id, d.motivo.trim());
      else await matricesRepo.rechazar(tx, id, actor.id, d.motivo.trim());
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PRIORIZACION,
        accion: d.decision === 'APROBAR' ? ACCION.MATRIZ_APROBADA : ACCION.MATRIZ_RECHAZADA,
        entidad: 'matriz',
        entidadId: id,
        valorNuevo: {
          version: m.version,
          estado: d.decision === 'APROBAR' ? 'VIGENTE' : 'RECHAZADA',
        },
        justificacion: d.motivo.trim() || null,
        ip: ctx.ip,
      });
    });
    return this.obtener(id);
  }

  /**
   * Simula el efecto de una versión sobre los casos validados de la vigencia: puntaje y posición con ella frente a los
   * actuales. No guarda nada (RF-PRI-02).
   */
  async simular(id: number) {
    const { pool } = this.deps;
    const matriz = await matricesRepo.porId(pool, id);
    if (!matriz) throw notFound('La versión de la matriz no existe', 'MATRIZ_NO_ENCONTRADA');
    const vigente = await matricesRepo.vigente(pool);
    const vigenciaId = await calculosRepo.vigenciaActivaId(pool);
    const candidatos = await calculosRepo.candidatos(pool, vigenciaId);

    const simulados = [];
    for (const c of candidatos) {
      const valores = await this.priorizacion.valoresDelCaso(pool, c.solicitudId, matriz.variables);
      const r = calcularPuntaje(matriz.variables, valores);
      simulados.push({
        c,
        puntajeFinal: r.puntaje,
        aportes: Object.fromEntries(r.detalle.map((x) => [x.variable, x.aporte])),
        faltantes: r.faltantes.map((f) => f.nombre),
        radicadaAt: c.radicadaAt,
        radicado: c.radicado,
      });
    }
    const posSimulada = new Map(
      ordenarPorPrioridad(simulados, matriz.desempate).map((x, i) => [x.c.solicitudId, i + 1]),
    );
    const actuales = candidatos
      .filter((c) => c.puntajeActual !== null)
      .map((c) => ({
        c,
        puntajeFinal: c.puntajeActual as number,
        aportes: c.aportesActuales ?? {},
        radicadaAt: c.radicadaAt,
        radicado: c.radicado,
      }));
    const posActual = new Map(
      ordenarPorPrioridad(actuales, vigente?.desempate ?? []).map((x, i) => [
        x.c.solicitudId,
        i + 1,
      ]),
    );

    const filas = simulados
      .map((x) => {
        const sim = posSimulada.get(x.c.solicitudId) as number;
        const act = posActual.get(x.c.solicitudId) ?? null;
        return {
          solicitudId: x.c.solicitudId,
          radicado: x.c.radicado,
          pcdNombre: x.c.pcdNombre,
          puntajeActual: x.c.puntajeActual,
          puntajeSimulado: x.puntajeFinal,
          posicionActual: act,
          posicionSimulada: sim,
          cambio: act === null ? null : act - sim,
          faltantes: x.faltantes,
        };
      })
      .sort((a, b) => a.posicionSimulada - b.posicionSimulada);
    const conCambio = filas.filter((f) => f.cambio !== null && f.cambio !== 0);
    return {
      matriz: {
        id: matriz.id,
        version: matriz.version,
        puntajeMaximo: puntajeMaximo(matriz.variables),
      },
      vigenteVersion: vigente?.version ?? null,
      resumen: {
        casos: filas.length,
        conPuntajeActual: actuales.length,
        cambianPosicion: conCambio.length,
        suben: conCambio.filter((f) => (f.cambio as number) > 0).length,
        bajan: conCambio.filter((f) => (f.cambio as number) < 0).length,
        sinDatos: filas.filter((f) => f.faltantes.length > 0).length,
      },
      items: filas.slice(0, MAX_FILAS_SIMULACION),
      truncado: filas.length > MAX_FILAS_SIMULACION,
    };
  }
}
