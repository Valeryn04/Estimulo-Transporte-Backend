import { ACCION, MODULO } from '../domain/acciones.js';
import {
  ESTADOS_PRIORIZABLES,
  calcularPuntaje,
  describirCriterio,
  ordenarPorPrioridad,
  redondear,
  valorSubsidios,
  type VariableMatriz,
} from '../domain/priorizacion.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction, type Queryable } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { caracterizacionRepo } from '../infrastructure/repositories/caracterizacion.js';
import {
  calculosRepo,
  excepcionesRepo,
  matricesRepo,
  variablesCasoRepo,
  type Calculo,
  type Excepcion,
  type EstadoExcepcion,
  type FiltroListado,
} from '../infrastructure/repositories/priorizacion.js';
import { DataCipher } from '../infrastructure/security/crypto.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ArchivoEntrada, ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';

export type ResultadoCalculo =
  { ok: true; calculo: Calculo } | { ok: false; faltantes: { codigo: string; nombre: string }[] };

const vistaCalculo = (c: Calculo) => ({
  id: c.id,
  matrizVersion: c.matrizVersion,
  puntaje: c.puntaje,
  detalle: c.detalle,
  vigente: c.vigente,
  calculadoPor: c.calculadoPor,
  calculadoAt: c.calculadoAt.toISOString(),
});

const vistaExcepcion = (e: Excepcion) => ({
  id: e.id,
  solicitudId: e.solicitudId,
  radicado: e.radicado,
  pcdNombre: e.pcdNombre,
  puntajeOriginal: e.puntajeOriginal,
  ajuste: e.ajuste,
  puntajeConAjuste: redondear(e.puntajeOriginal + e.ajuste),
  justificacion: e.justificacion,
  evidencia: e.evidencia,
  estado: e.estado,
  propuestaPor: e.propuestaPor,
  propuestaAt: e.propuestaAt.toISOString(),
  decididaPor: e.decididaPor,
  decididaAt: e.decididaAt?.toISOString() ?? null,
  motivoDecision: e.motivoDecision,
  aplicable: e.aplicable,
});

/**
 * Cálculo del puntaje (RF-PRI-01), excepciones justificadas (RF-PRI-03) y listado priorizado (RF-PRI-04). El puntaje
 * automático nunca se sobrescribe: cada cálculo queda con su versión de la matriz y, si hay un ajuste aprobado, el
 * puntaje final es el calculado más el ajuste.
 */
export class ServicioPriorizacion {
  private readonly cipher: DataCipher;

  constructor(
    private readonly deps: Dependencias,
    private readonly documentos: ServicioDocumentos,
  ) {
    this.cipher = new DataCipher(deps.env.encryption);
  }

  /** Valor de cada variable de la matriz para un caso: lo que registró el validador y lo que sale de la caracterización. */
  async valoresDelCaso(
    db: Queryable,
    solicitudId: number,
    variables: readonly VariableMatriz[],
  ): Promise<Record<string, string | undefined>> {
    const valores: Record<string, string | undefined> = {
      ...(await variablesCasoRepo.valores(db, solicitudId)),
    };
    if (variables.some((v) => v.origen === 'SUBSIDIOS')) {
      const car = await caracterizacionRepo.obtener(db, solicitudId, this.cipher);
      const subsidio = valorSubsidios(car?.datos.recibeSubsidios);
      for (const v of variables) if (v.origen === 'SUBSIDIOS') valores[v.codigo] = subsidio;
    }
    return valores;
  }

  /** Calcula y guarda el puntaje con la matriz vigente. Si faltan datos no guarda nada. */
  async calcularEnTx(
    tx: Queryable,
    solicitudId: number,
    usuarioId: number | null,
  ): Promise<ResultadoCalculo> {
    const matriz = await matricesRepo.vigente(tx);
    if (!matriz) throw conflict('SIN_MATRIZ', 'No hay una matriz de ponderación vigente.');
    const valores = await this.valoresDelCaso(tx, solicitudId, matriz.variables);
    const r = calcularPuntaje(matriz.variables, valores);
    if (r.faltantes.length > 0) return { ok: false, faltantes: r.faltantes };
    await calculosRepo.guardar(tx, {
      solicitudId,
      matrizId: matriz.id,
      puntaje: r.puntaje,
      detalle: r.detalle,
      usuarioId,
    });
    return { ok: true, calculo: (await calculosRepo.vigente(tx, solicitudId)) as Calculo };
  }

  // ---------------------------------------------------------------- cálculo individual y masivo

  async calcularCaso(actor: Actor, solicitudId: number, ctx: ContextoPeticion) {
    const calculo = await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const estado = await tx.query<{ estado: string; radicado: string }>(
        `SELECT estado, radicado FROM solicitudes WHERE id = $1 FOR UPDATE`,
        [solicitudId],
      );
      const fila = estado.rows[0];
      if (!fila) throw notFound('El caso no existe', 'CASO_NO_ENCONTRADO');
      if (!(ESTADOS_PRIORIZABLES as readonly string[]).includes(fila.estado)) {
        throw conflict('CASO_NO_VALIDADO', 'Solo se calcula el puntaje de los casos validados.');
      }
      const r = await this.calcularEnTx(tx, solicitudId, actor.id);
      if (!r.ok) {
        throw errorValidacion([
          {
            campo: 'variables',
            mensaje: `Faltan datos de priorización: ${r.faltantes.map((f) => f.nombre).join(', ')}.`,
          },
        ]);
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PRIORIZACION,
        accion: ACCION.PRIORIZACION_CALCULADA,
        entidad: 'priorizacion',
        entidadId: r.calculo.id,
        solicitudId,
        valorNuevo: { puntaje: r.calculo.puntaje, matrizVersion: r.calculo.matrizVersion },
        ip: ctx.ip,
      });
      return r.calculo;
    });
    return vistaCalculo(calculo);
  }

  /**
   * Cálculo masivo de los casos validados de la vigencia activa. Sin «recalcular» solo se calculan los que aún no
   * tienen puntaje; con «recalcular» también los que se calcularon con otra versión de la matriz.
   */
  async calcularMasivo(actor: Actor, opciones: { recalcular: boolean }, ctx: ContextoPeticion) {
    const { pool } = this.deps;
    const matriz = await matricesRepo.vigente(pool);
    if (!matriz) throw conflict('SIN_MATRIZ', 'No hay una matriz de ponderación vigente.');
    const vigenciaId = await calculosRepo.vigenciaActivaId(pool);
    const candidatos = await calculosRepo.candidatos(pool, vigenciaId);
    let calculados = 0;
    let sinCambio = 0;
    const omitidos: { radicado: string; motivo: string }[] = [];
    for (const c of candidatos) {
      const yaCalculado = c.puntajeActual !== null;
      if (yaCalculado && (!opciones.recalcular || c.matrizId === matriz.id)) {
        sinCambio++;
        continue;
      }
      const r = await withTransaction(pool, async (tx) => {
        await fijarActor(tx, actor.id);
        return this.calcularEnTx(tx, c.solicitudId, actor.id);
      });
      if (r.ok) calculados++;
      else {
        omitidos.push({
          radicado: c.radicado,
          motivo: `Faltan datos: ${r.faltantes.map((f) => f.nombre).join(', ')}`,
        });
      }
    }
    await bitacoraRepo.registrar(pool, {
      usuarioId: actor.id,
      modulo: MODULO.PRIORIZACION,
      accion: ACCION.PRIORIZACION_MASIVA,
      entidad: 'priorizacion',
      detalle: {
        matrizVersion: matriz.version,
        recalcular: opciones.recalcular,
        calculados,
        sinCambio,
        omitidos: omitidos.length,
      },
      ip: ctx.ip,
    });
    return { matrizVersion: matriz.version, calculados, sinCambio, omitidos };
  }

  // ---------------------------------------------------------------- listado priorizado (RF-PRI-04)

  async listado(f: FiltroListado & { limit: number; offset: number }) {
    const { pool } = this.deps;
    const matriz = await matricesRepo.vigente(pool);
    const vigenciaId = f.vigenciaId ?? (await calculosRepo.vigenciaActivaId(pool)) ?? undefined;
    const filas = await calculosRepo.listado(pool, { ...f, vigenciaId });
    const ordenadas = ordenarPorPrioridad(
      filas.map((x) => ({
        ...x,
        puntajeFinal: redondear(x.puntaje + x.ajuste),
        aportes: x.aportes,
      })),
      matriz?.desempate ?? [],
    );
    const variables = matriz?.variables ?? [];
    const pagina = ordenadas.slice(f.offset, f.offset + f.limit);
    return {
      items: pagina.map((x) => ({
        posicion: ordenadas.indexOf(x) + 1,
        solicitudId: x.solicitudId,
        radicado: x.radicado,
        radicadaAt: x.radicadaAt.toISOString(),
        estado: x.estado,
        pcdNombre: x.pcdNombre,
        localidad: x.localidad,
        transporte: x.transporte,
        conCuidador: x.conCuidador,
        puntaje: x.puntaje,
        ajuste: x.ajuste,
        puntajeFinal: x.puntajeFinal,
        matrizVersion: x.matrizVersion,
        calculadoAt: x.calculadoAt.toISOString(),
        criterioDesempate: describirCriterio(x.criterioDesempate, variables),
        excepcionPendiente: x.excepcionPendienteId !== null,
      })),
      total: ordenadas.length,
      matrizVersion: matriz?.version ?? null,
      desempate: (matriz?.desempate ?? []).map((c) => describirCriterio(c, variables)),
      vigenciaId: vigenciaId ?? null,
    };
  }

  /** Listas para filtrar el listado: localidades y tipos de transporte. */
  async filtros() {
    const r = await this.deps.pool.query<{ id: number; catalogo: string; nombre: string }>(
      `SELECT id, catalogo, nombre FROM catalogo_items
        WHERE catalogo IN ('LOCALIDAD', 'TIPO_TRANSPORTE') AND activo ORDER BY catalogo, nombre`,
    );
    const de = (c: string) =>
      r.rows.filter((x) => x.catalogo === c).map((x) => ({ id: x.id, nombre: x.nombre }));
    return { localidades: de('LOCALIDAD'), tiposTransporte: de('TIPO_TRANSPORTE') };
  }

  /** Cálculos (con su historia) y excepciones de un caso. */
  async caso(solicitudId: number) {
    const { pool } = this.deps;
    const s = await pool.query<{
      id: number;
      radicado: string;
      estado: string;
      pcd_nombre: string;
    }>(
      `SELECT s.id, s.radicado, s.estado, p.nombre_completo AS pcd_nombre
         FROM solicitudes s JOIN personas p ON p.id = s.pcd_id WHERE s.id = $1`,
      [solicitudId],
    );
    const fila = s.rows[0];
    if (!fila) throw notFound('El caso no existe', 'CASO_NO_ENCONTRADO');
    const [calculos, excepciones] = await Promise.all([
      calculosRepo.historial(pool, solicitudId),
      excepcionesRepo.listar(pool, { solicitudId, limit: 100, offset: 0 }),
    ]);
    const vigente = calculos.find((c) => c.vigente) ?? null;
    const aprobada = excepciones.items.find((e) => e.aplicable) ?? null;
    return {
      solicitud: {
        id: fila.id,
        radicado: fila.radicado,
        estado: fila.estado,
        pcdNombre: fila.pcd_nombre,
      },
      puntaje: vigente?.puntaje ?? null,
      ajuste: aprobada?.ajuste ?? 0,
      puntajeFinal: vigente ? redondear(vigente.puntaje + (aprobada?.ajuste ?? 0)) : null,
      calculos: calculos.map(vistaCalculo),
      excepciones: excepciones.items.map(vistaExcepcion),
    };
  }

  // ---------------------------------------------------------------- excepciones (RF-PRI-03)

  async listarExcepciones(f: { estado?: EstadoExcepcion; limit: number; offset: number }) {
    const r = await excepcionesRepo.listar(this.deps.pool, f);
    return { items: r.items.map(vistaExcepcion), total: r.total };
  }

  async proponerExcepcion(
    actor: Actor,
    solicitudId: number,
    d: { ajuste: number; justificacion: string },
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const calculo = await calculosRepo.vigente(pool, solicitudId);
    if (!calculo) {
      throw conflict('CASO_SIN_PUNTAJE', 'El caso todavía no tiene puntaje calculado.');
    }
    if (calculo.puntaje + d.ajuste < 0) {
      throw errorValidacion([
        { campo: 'ajuste', mensaje: 'Ajuste: el puntaje con el ajuste no puede ser negativo' },
      ]);
    }
    const evidencia = await this.documentos.guardarEvidencia(`excepciones/${solicitudId}`, archivo);
    const id = await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const actual = await calculosRepo.vigente(tx, solicitudId);
      if (!actual || actual.id !== calculo.id) {
        throw conflict('CALCULO_CAMBIO', 'El puntaje del caso cambió: vuelva a abrirlo.');
      }
      const aprobada = await tx.query(
        `SELECT 1 FROM priorizacion_excepciones WHERE priorizacion_id = $1 AND estado = 'APROBADA'`,
        [actual.id],
      );
      if (aprobada.rowCount) {
        throw conflict('EXCEPCION_YA_APLICADA', 'Este puntaje ya tiene un ajuste aprobado.');
      }
      let nuevo: number;
      try {
        nuevo = await excepcionesRepo.crear(tx, {
          solicitudId,
          priorizacionId: actual.id,
          ajuste: d.ajuste,
          justificacion: d.justificacion,
          evidencia,
          usuarioId: actor.id,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict(
            'EXCEPCION_ABIERTA',
            'Este caso ya tiene una excepción pendiente de decisión.',
          );
        }
        throw error;
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PRIORIZACION,
        accion: ACCION.EXCEPCION_PROPUESTA,
        entidad: 'excepcion',
        entidadId: nuevo,
        solicitudId,
        valorNuevo: { ajuste: d.ajuste, puntajeOriginal: actual.puntaje },
        justificacion: d.justificacion,
        detalle: { evidencia: evidencia.nombre, sha256: evidencia.sha256 },
        ip: ctx.ip,
      });
      return nuevo;
    });
    return vistaExcepcion((await excepcionesRepo.porId(pool, id)) as Excepcion);
  }

  async decidirExcepcion(
    actor: Actor,
    id: number,
    d: { decision: 'APROBAR' | 'RECHAZAR'; motivo: string },
    ctx: ContextoPeticion,
  ) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const e = await excepcionesRepo.porId(tx, id);
      if (!e) throw notFound('La excepción no existe', 'EXCEPCION_NO_ENCONTRADA');
      if (e.estado !== 'PROPUESTA') {
        throw conflict('EXCEPCION_DECIDIDA', 'Esta excepción ya fue decidida.');
      }
      if (e.propuestaPorId === actor.id) {
        throw conflict(
          'MISMA_PERSONA',
          'La excepción debe decidirla alguien distinto de quien la propuso.',
        );
      }
      if (d.decision === 'RECHAZAR' && d.motivo.trim().length < 5) {
        throw errorValidacion([
          { campo: 'motivo', mensaje: 'Motivo: explique por qué se rechaza (mínimo 5 caracteres)' },
        ]);
      }
      if (d.decision === 'APROBAR') {
        const vigente = await calculosRepo.vigente(tx, e.solicitudId);
        if (!vigente || vigente.id !== e.priorizacionId) {
          throw conflict(
            'CALCULO_DESACTUALIZADO',
            'El puntaje del caso se recalculó después de esta propuesta: recházela y proponga el ajuste de nuevo.',
          );
        }
      }
      await excepcionesRepo.decidir(
        tx,
        id,
        d.decision === 'APROBAR' ? 'APROBADA' : 'RECHAZADA',
        actor.id,
        d.motivo.trim(),
      );
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.PRIORIZACION,
        accion: d.decision === 'APROBAR' ? ACCION.EXCEPCION_APROBADA : ACCION.EXCEPCION_RECHAZADA,
        entidad: 'excepcion',
        entidadId: id,
        solicitudId: e.solicitudId,
        valorAnterior: { estado: 'PROPUESTA' },
        valorNuevo: {
          estado: d.decision === 'APROBAR' ? 'APROBADA' : 'RECHAZADA',
          ajuste: e.ajuste,
        },
        justificacion: d.motivo.trim() || null,
        ip: ctx.ip,
      });
    });
    return vistaExcepcion((await excepcionesRepo.porId(this.deps.pool, id)) as Excepcion);
  }

  /** Evidencia de la excepción, para quien tiene acceso a la priorización. */
  async evidencia(id: number) {
    const e = await excepcionesRepo.rutaEvidencia(this.deps.pool, id);
    if (!e) throw notFound('La excepción no existe', 'EXCEPCION_NO_ENCONTRADA');
    return this.documentos.leerEvidencia(e);
  }
}
