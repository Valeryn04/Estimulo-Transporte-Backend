import { ACCION, MODULO } from '../domain/acciones.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction, type Queryable } from '../infrastructure/db/pool.js';
import { alertasRepo, type EstadoBeneficio } from '../infrastructure/repositories/asignacion.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import type { Estructura } from '../infrastructure/repositories/cruces.js';
import { entregasRepo } from '../infrastructure/repositories/entregas.js';
import {
  alertasCruceRepo,
  novedadesRepo,
  revocatoriasRepo,
  type EstadoAlertaCruce,
  type EstadoRevocatoria,
  type Revocatoria,
  type TipoNovedad,
} from '../infrastructure/repositories/novedades.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { conflict, notFound } from '../shared/errors.js';
import type { ServicioAsignacion } from './asignacion.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import type { ArchivoEntrada, ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';
import type { ServicioCruces } from './cruces.js';

const FECHA = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });
const FECHA_HORA = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeZone: 'America/Bogota',
});
const PERMISO_GESTOR = 'novedades.gestionar';

const NOMBRE_TIPO: Record<TipoNovedad, string> = {
  BLOQUEO: 'Bloqueo temporal',
  SUSPENSION: 'Suspensión',
  LEVANTAMIENTO: 'Reactivación del beneficio',
};

const vistaRevocatoria = (r: Revocatoria) => ({
  id: r.id,
  beneficioId: r.beneficioId,
  radicado: r.radicado,
  pcdNombre: r.pcdNombre,
  causal: r.causal,
  descripcion: r.descripcion,
  estado: r.estado,
  resultado: r.resultado,
  trasladoAt: r.trasladoAt?.toISOString() ?? null,
  venceDescargosAt: r.venceDescargosAt?.toISOString() ?? null,
  descargosAt: r.descargosAt?.toISOString() ?? null,
  sinDescargos: r.sinDescargos,
  decididaAt: r.decididaAt?.toISOString() ?? null,
  iniciadaPor: r.iniciadaPor,
  creadaAt: r.creadaAt.toISOString(),
});

/**
 * Novedades, revocatoria y alertas de cruce del beneficio (RF-NOV-01..03). Todo cambio de estado se hace sin borrar el
 * historial; la revocatoria no se puede finalizar sin agotar traslado, descargos y acto motivado, y una alerta de cruce
 * nunca modifica el beneficio: solo la analiza una persona.
 */
export class ServicioNovedades {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
    private readonly documentos: ServicioDocumentos,
    private readonly asignacion: ServicioAsignacion,
    private readonly cruces: ServicioCruces,
  ) {}

  // ---------------------------------------------------------------- novedades (RF-NOV-01)

  async resumen(f: { estado?: EstadoBeneficio; q?: string; limit: number; offset: number }) {
    return novedadesRepo.resumen(this.deps.pool, f);
  }

  async causales() {
    const { pool } = this.deps;
    return {
      bloqueo: await novedadesRepo.causales(pool, 'CAUSAL_BLOQUEO'),
      revocatoria: await novedadesRepo.causales(pool, 'CAUSAL_REVOCATORIA'),
    };
  }

  /** Expediente de novedades del beneficio: la secuencia completa de bloqueos, levantamientos y revocatorias. */
  async beneficio(beneficioId: number) {
    const { pool } = this.deps;
    const b = await entregasRepo.beneficio(pool, beneficioId);
    if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
    const [novedades, revocatorias] = await Promise.all([
      novedadesRepo.delBeneficio(pool, beneficioId),
      revocatoriasRepo.listar(pool, { limit: 100, offset: 0 }),
    ]);
    return {
      beneficio: {
        id: b.id,
        radicado: b.radicado,
        estado: b.estado,
        pcdNombre: b.pcdNombre,
        hoy: b.hoy,
        asignadoDia: b.asignadoDia,
      },
      novedades: novedades.map((n) => ({
        ...n,
        tipoNombre: NOMBRE_TIPO[n.tipo],
        creadaAt: n.creadaAt.toISOString(),
      })),
      revocatorias: revocatorias.items
        .filter((r) => r.beneficioId === beneficioId)
        .map(vistaRevocatoria),
      causales: await this.causales(),
    };
  }

  /** Bloquea, suspende o reactiva el beneficio, con causal, fecha efectiva, evidencia, responsable y comunicación. */
  async registrarNovedad(
    actor: Actor,
    beneficioId: number,
    d: {
      tipo: TipoNovedad;
      causalId?: number;
      fechaEfectiva: string;
      observacion: string;
      levantamientoProgramado?: string;
    },
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const errores: { campo: string; mensaje: string }[] = [];
    if (d.tipo === 'LEVANTAMIENTO' && d.observacion.trim().length < 5) {
      errores.push({
        campo: 'observacion',
        mensaje: 'Observación: explique la reactivación (mínimo 5 caracteres)',
      });
    }
    if (d.tipo !== 'LEVANTAMIENTO' && !d.causalId) {
      errores.push({ campo: 'causalId', mensaje: 'Causal: elija una de la lista' });
    }
    if (d.tipo === 'LEVANTAMIENTO' && d.levantamientoProgramado) {
      errores.push({
        campo: 'levantamientoProgramado',
        mensaje: 'Una reactivación no se programa',
      });
    }
    if (errores.length > 0) throw errorValidacion(errores);
    const evidencia = await this.documentos.guardarEvidencia(`novedades/${beneficioId}`, archivo);

    const nombreCausal = { valor: '' };
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const b = await entregasRepo.beneficio(tx, beneficioId, true);
      if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
      const problemas: { campo: string; mensaje: string }[] = [];
      if (d.fechaEfectiva < b.asignadoDia) {
        problemas.push({
          campo: 'fechaEfectiva',
          mensaje: 'Fecha efectiva: no puede ser anterior a la asignación',
        });
      }
      if (d.levantamientoProgramado && d.levantamientoProgramado < d.fechaEfectiva) {
        problemas.push({
          campo: 'levantamientoProgramado',
          mensaje: 'Levantamiento programado: no puede ser anterior a la fecha efectiva',
        });
      }
      let abierta = null;
      if (d.tipo === 'LEVANTAMIENTO') {
        if (b.estado !== 'BLOQUEADO' && b.estado !== 'SUSPENDIDO') {
          throw conflict('BENEFICIO_NO_BLOQUEADO', 'El beneficio no está bloqueado ni suspendido.');
        }
        abierta = await novedadesRepo.abierta(tx, beneficioId);
        if (!abierta)
          throw conflict('SIN_NOVEDAD_ABIERTA', 'No hay una novedad abierta por levantar.');
      } else {
        if (b.estado !== 'ACTIVO') {
          throw conflict('BENEFICIO_NO_ACTIVO', 'Solo se bloquea o suspende un beneficio activo.');
        }
        const causal = await novedadesRepo.causalDe(tx, 'CAUSAL_BLOQUEO', d.causalId as number);
        if (!causal) {
          problemas.push({ campo: 'causalId', mensaje: 'Causal: elija una de la lista' });
        } else nombreCausal.valor = causal.nombre;
      }
      if (problemas.length > 0) throw errorValidacion(problemas);

      const nuevoEstado: EstadoBeneficio =
        d.tipo === 'LEVANTAMIENTO' ? 'ACTIVO' : d.tipo === 'BLOQUEO' ? 'BLOQUEADO' : 'SUSPENDIDO';
      // La persona se entera por correo; el registro de la novedad guarda cuál fue la comunicación.
      const correoId = await this.correos.encolar(tx, {
        solicitudId: b.solicitudId,
        tipo: 'NOVEDAD_BENEFICIO',
        destinatario: b.correo,
        datos: {
          nombre: b.pcdNombre,
          radicado: b.radicado,
          tipoNovedad: NOMBRE_TIPO[d.tipo],
          causal: nombreCausal.valor || 'Se superó la causa que originó el bloqueo',
          fechaEfectiva: FECHA.format(new Date(`${d.fechaEfectiva}T00:00:00Z`)),
          observacion: d.observacion.trim(),
          enlaceConsulta: await this.correos.enlaceConsulta(tx, b.solicitudId),
        },
      });
      const id = await novedadesRepo.crear(tx, {
        beneficioId,
        tipo: d.tipo,
        causalId: d.tipo === 'LEVANTAMIENTO' ? null : (d.causalId as number),
        fechaEfectiva: d.fechaEfectiva,
        observacion: d.observacion.trim(),
        evidencia,
        usuarioId: actor.id,
        levantamientoProgramado: d.levantamientoProgramado ?? null,
        levantaNovedadId: abierta?.id ?? null,
        estadoPrevio: b.estado,
        correoId,
      });
      await entregasRepo.fijarEstado(tx, beneficioId, nuevoEstado, false);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.NOVEDAD_REGISTRADA,
        entidad: 'novedad',
        entidadId: id,
        solicitudId: b.solicitudId,
        valorAnterior: { estado: b.estado },
        valorNuevo: { estado: nuevoEstado, tipo: d.tipo },
        justificacion: d.observacion.trim() || null,
        detalle: {
          beneficioId,
          causal: nombreCausal.valor || null,
          fechaEfectiva: d.fechaEfectiva,
          levantamientoProgramado: d.levantamientoProgramado ?? null,
          evidencia: evidencia.nombre,
          sha256: evidencia.sha256,
          correoId,
        },
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
    return this.beneficio(beneficioId);
  }

  async evidenciaDeNovedad(id: number) {
    const e = await novedadesRepo.evidencia(this.deps.pool, id);
    if (!e) throw notFound('La novedad no existe', 'NOVEDAD_NO_ENCONTRADA');
    return this.documentos.leerEvidencia(e);
  }

  // ---------------------------------------------------------------- revocatoria (RF-NOV-02)

  async listarRevocatorias(f: { estado?: EstadoRevocatoria; limit: number; offset: number }) {
    const r = await revocatoriasRepo.listar(this.deps.pool, f);
    return { total: r.total, items: r.items.map(vistaRevocatoria) };
  }

  async revocatoria(id: number) {
    const { pool } = this.deps;
    const r = await revocatoriasRepo.porId(pool, id);
    if (!r) throw notFound('La revocatoria no existe', 'REVOCATORIA_NO_ENCONTRADA');
    const eventos = await revocatoriasRepo.eventos(pool, id);
    const plazoDecision = await parametrosRepo.entero(pool, 'plazo_decision_dias');
    return {
      ...vistaRevocatoria(r),
      puedeDecidir: r.estado === 'CON_DESCARGOS' || (r.estado === 'EN_TRASLADO' && r.sinDescargos),
      puedeSinDescargos:
        r.estado === 'EN_TRASLADO' &&
        !r.sinDescargos &&
        r.venceDescargosAt !== null &&
        r.venceDescargosAt.getTime() < Date.now(),
      plazoDecisionDias: plazoDecision,
      eventos: eventos.map((e) => ({ ...e, creadoAt: e.creadoAt.toISOString() })),
    };
  }

  async evidenciaDeEvento(id: number) {
    const e = await revocatoriasRepo.evidenciaDeEvento(this.deps.pool, id);
    if (!e) throw notFound('Ese registro no tiene archivo', 'EVIDENCIA_NO_ENCONTRADA');
    return this.documentos.leerEvidencia(e);
  }

  /** Inicia la revocatoria: causal y evidencia que la sustentan. */
  async iniciarRevocatoria(
    actor: Actor,
    beneficioId: number,
    d: { causalId: number; descripcion: string },
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
    origenAlertaId: number | null = null,
    tx?: Queryable,
  ): Promise<number> {
    const evidencia = await this.documentos.guardarEvidencia(
      `revocatorias/${beneficioId}`,
      archivo,
    );
    const hacer = async (db: Queryable): Promise<number> => {
      await fijarActor(db, actor.id);
      const b = await entregasRepo.beneficio(db, beneficioId, true);
      if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
      if (b.estado === 'FINALIZADO') {
        throw conflict('BENEFICIO_FINALIZADO', 'El beneficio ya está finalizado.');
      }
      const causal = await novedadesRepo.causalDe(db, 'CAUSAL_REVOCATORIA', d.causalId);
      if (!causal)
        throw errorValidacion([{ campo: 'causalId', mensaje: 'Causal: elija una de la lista' }]);
      if (d.descripcion.trim().length < 10) {
        throw errorValidacion([
          {
            campo: 'descripcion',
            mensaje: 'Descripción: explique los hechos (mínimo 10 caracteres)',
          },
        ]);
      }
      let id: number;
      try {
        id = await revocatoriasRepo.crear(db, {
          beneficioId,
          causalId: d.causalId,
          descripcion: d.descripcion.trim(),
          usuarioId: actor.id,
          origenAlertaId,
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw conflict(
            'REVOCATORIA_ABIERTA',
            'Este beneficio ya tiene una revocatoria en curso.',
          );
        }
        throw error;
      }
      await revocatoriasRepo.evento(db, {
        revocatoriaId: id,
        etapa: 'INICIO',
        texto: d.descripcion.trim(),
        fecha: b.hoy,
        evidencia,
        usuarioId: actor.id,
      });
      await bitacoraRepo.registrar(db, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.REVOCATORIA_INICIADA,
        entidad: 'revocatoria',
        entidadId: id,
        solicitudId: b.solicitudId,
        valorNuevo: { causal: causal.nombre },
        justificacion: d.descripcion.trim(),
        detalle: {
          beneficioId,
          evidencia: evidencia.nombre,
          sha256: evidencia.sha256,
          origenAlertaId,
        },
        ip: ctx.ip,
      });
      return id;
    };
    return tx ? hacer(tx) : withTransaction(this.deps.pool, hacer);
  }

  /** Comunica a la persona las razones y le abre el plazo para presentar descargos. */
  async registrarTraslado(
    actor: Actor,
    id: number,
    d: { texto: string },
    archivo: ArchivoEntrada | null,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    if (d.texto.trim().length < 20) {
      throw errorValidacion([
        {
          campo: 'texto',
          mensaje: 'Traslado: escriba las razones que se comunican (mínimo 20 caracteres)',
        },
      ]);
    }
    const evidencia = archivo
      ? await this.documentos.guardarEvidencia(`revocatorias/${id}`, archivo)
      : null;
    const plazo = await parametrosRepo.entero(pool, 'plazo_descargos_dias');
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const r = await revocatoriasRepo.porId(tx, id, true);
      if (!r) throw notFound('La revocatoria no existe', 'REVOCATORIA_NO_ENCONTRADA');
      if (r.estado !== 'INICIADA') {
        throw conflict(
          'ETAPA_INVALIDA',
          'El traslado se registra una sola vez, justo después de iniciar el trámite.',
        );
      }
      const vence = (
        await tx.query<{ v: Date }>(
          `SELECT (((hoy_bogota() + $1::int + 1)::timestamp AT TIME ZONE 'America/Bogota') - interval '1 second') AS v`,
          [plazo],
        )
      ).rows[0]!.v;
      const correoId = await this.correos.encolar(tx, {
        solicitudId: r.solicitudId,
        tipo: 'REVOCATORIA_TRASLADO',
        destinatario: r.correo,
        datos: {
          nombre: r.pcdNombre,
          radicado: r.radicado,
          causal: r.causal,
          traslado: d.texto.trim(),
          fechaLimite: FECHA_HORA.format(vence),
          enlaceConsulta: await this.correos.enlaceConsulta(tx, r.solicitudId, plazo + 1),
        },
      });
      await revocatoriasRepo.evento(tx, {
        revocatoriaId: id,
        etapa: 'TRASLADO',
        texto: d.texto.trim(),
        fecha: (await entregasRepo.beneficio(tx, r.beneficioId))!.hoy,
        evidencia,
        usuarioId: actor.id,
        correoId,
      });
      await revocatoriasRepo.fijarTraslado(tx, id, vence);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.REVOCATORIA_TRASLADO,
        entidad: 'revocatoria',
        entidadId: id,
        solicitudId: r.solicitudId,
        valorAnterior: { estado: r.estado },
        valorNuevo: { estado: 'EN_TRASLADO', venceDescargosAt: vence.toISOString() },
        detalle: { plazoDias: plazo, correoId },
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
    return this.revocatoria(id);
  }

  /** Registra los descargos de la persona (recibidos dentro del plazo) o, vencido el plazo, que no hubo. */
  async registrarDescargos(
    actor: Actor,
    id: number,
    d: { texto: string; sinDescargos: boolean },
    archivo: ArchivoEntrada | null,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    if (!d.sinDescargos && d.texto.trim().length < 10) {
      throw errorValidacion([
        { campo: 'texto', mensaje: 'Descargos: registre lo que presentó la persona' },
      ]);
    }
    const evidencia = archivo
      ? await this.documentos.guardarEvidencia(`revocatorias/${id}`, archivo)
      : null;
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const r = await revocatoriasRepo.porId(tx, id, true);
      if (!r) throw notFound('La revocatoria no existe', 'REVOCATORIA_NO_ENCONTRADA');
      if (r.estado !== 'EN_TRASLADO' || r.sinDescargos) {
        throw conflict(
          'ETAPA_INVALIDA',
          'Todavía no se puede registrar esta etapa, o ya se registró.',
        );
      }
      const vencido = (r.venceDescargosAt as Date).getTime() < Date.now();
      if (d.sinDescargos && !vencido) {
        throw conflict(
          'PLAZO_VIGENTE',
          'La persona todavía está dentro del plazo para presentar sus descargos.',
        );
      }
      if (!d.sinDescargos && vencido) {
        throw conflict('PLAZO_VENCIDO', 'El plazo para presentar descargos ya venció.');
      }
      const hoy = (await entregasRepo.beneficio(tx, r.beneficioId))!.hoy;
      await revocatoriasRepo.evento(tx, {
        revocatoriaId: id,
        etapa: d.sinDescargos ? 'SIN_DESCARGOS' : 'DESCARGOS',
        texto: d.sinDescargos
          ? 'Venció el plazo sin que la persona presentara descargos.'
          : d.texto.trim(),
        fecha: hoy,
        evidencia,
        usuarioId: actor.id,
      });
      if (d.sinDescargos) await revocatoriasRepo.fijarSinDescargos(tx, id);
      else await revocatoriasRepo.fijarDescargos(tx, id);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.REVOCATORIA_DESCARGOS,
        entidad: 'revocatoria',
        entidadId: id,
        solicitudId: r.solicitudId,
        valorAnterior: { estado: r.estado },
        valorNuevo: {
          estado: d.sinDescargos ? 'EN_TRASLADO' : 'CON_DESCARGOS',
          sinDescargos: d.sinDescargos,
        },
        ip: ctx.ip,
      });
    });
    return this.revocatoria(id);
  }

  /**
   * Acto administrativo motivado que decide: solo con el traslado hecho y los descargos recibidos (o el plazo vencido).
   * Si revoca, el beneficio finaliza y el cupo queda libre para reasignar (RF-ASI-03).
   */
  async decidirRevocatoria(
    actor: Actor,
    id: number,
    d: { resultado: 'REVOCAR' | 'ARCHIVAR'; motivacion: string; numeroActo: string },
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const errores: { campo: string; mensaje: string }[] = [];
    if (d.motivacion.trim().length < 20) {
      errores.push({
        campo: 'motivacion',
        mensaje: 'Motivación: explique la decisión (mínimo 20 caracteres)',
      });
    }
    if (d.numeroActo.trim().length < 2) {
      errores.push({ campo: 'numeroActo', mensaje: 'Número del acto administrativo: escríbalo' });
    }
    if (errores.length > 0) throw errorValidacion(errores);
    const evidencia = await this.documentos.guardarEvidencia(`revocatorias/${id}`, archivo);
    const plazoRecursos = await parametrosRepo.entero(pool, 'plazo_recursos_dias');
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const r = await revocatoriasRepo.porId(tx, id, true);
      if (!r) throw notFound('La revocatoria no existe', 'REVOCATORIA_NO_ENCONTRADA');
      const listo = r.estado === 'CON_DESCARGOS' || (r.estado === 'EN_TRASLADO' && r.sinDescargos);
      if (!listo) {
        throw conflict(
          'ETAPAS_PENDIENTES',
          r.estado === 'DECIDIDA'
            ? 'Esta revocatoria ya fue decidida.'
            : 'No se puede decidir: falta agotar el traslado y los descargos (o el vencimiento de su plazo).',
        );
      }
      const hoy = (await entregasRepo.beneficio(tx, r.beneficioId))!.hoy;
      const correoId = await this.correos.encolar(tx, {
        solicitudId: r.solicitudId,
        tipo: 'REVOCATORIA_DECISION',
        destinatario: r.correo,
        datos: {
          nombre: r.pcdNombre,
          radicado: r.radicado,
          resultado:
            d.resultado === 'REVOCAR'
              ? 'Beneficio revocado'
              : 'Trámite archivado: el beneficio continúa',
          motivacion: d.motivacion.trim(),
          plazoRecursosDias: plazoRecursos,
          enlaceConsulta: await this.correos.enlaceConsulta(tx, r.solicitudId, plazoRecursos + 1),
        },
      });
      await revocatoriasRepo.evento(tx, {
        revocatoriaId: id,
        etapa: 'ACTO',
        texto: d.motivacion.trim(),
        fecha: hoy,
        referencia: d.numeroActo.trim(),
        evidencia,
        usuarioId: actor.id,
        correoId,
      });
      await revocatoriasRepo.decidir(tx, id, d.resultado === 'REVOCAR' ? 'REVOCADA' : 'ARCHIVADA');
      if (d.resultado === 'REVOCAR') {
        await this.asignacion.liberarCupo(
          tx,
          actor.id,
          r.beneficioId,
          `Revocatoria (${r.causal}), acto ${d.numeroActo.trim()}`,
          ctx,
        );
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.REVOCATORIA_DECIDIDA,
        entidad: 'revocatoria',
        entidadId: id,
        solicitudId: r.solicitudId,
        valorAnterior: { estado: r.estado },
        valorNuevo: {
          estado: 'DECIDIDA',
          resultado: d.resultado === 'REVOCAR' ? 'REVOCADA' : 'ARCHIVADA',
        },
        justificacion: d.motivacion.trim(),
        detalle: {
          acto: d.numeroActo.trim(),
          evidencia: evidencia.nombre,
          sha256: evidencia.sha256,
          correoId,
        },
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
    return this.revocatoria(id);
  }

  // ---------------------------------------------------------------- cruces periódicos (RF-NOV-03)

  /**
   * Compara un archivo recién cargado con los beneficios vigentes y genera alertas para el gestor. Nunca cambia el
   * estado de un beneficio: la alerta solo se analiza.
   */
  async evaluarCarga(estructura: Estructura, cargaId: number, actorId: number): Promise<number> {
    const { pool } = this.deps;
    if (estructura.alertaNovedad === 'NINGUNA') return 0;
    let desde: Date | null = null;
    if (estructura.alertaNovedad === 'AUSENCIA') {
      const meses = await parametrosRepo.entero(pool, 'inactividad_meses');
      desde = new Date();
      desde.setMonth(desde.getMonth() - meses);
    }
    const personas = await alertasCruceRepo.personasDeBeneficios(pool, desde);
    const huellas = personas.map((p) => this.cruces.huella(p.numero));
    const enCarga = await alertasCruceRepo.enCarga(pool, cargaId, huellas);
    const porBeneficio = new Map<
      number,
      { rol: 'PCD' | 'CUIDADOR'; aparece: boolean; detalle: string }[]
    >();
    personas.forEach((p, i) => {
      const lista = porBeneficio.get(p.beneficioId) ?? [];
      lista.push({
        rol: p.rol,
        aparece: enCarga.has(huellas[i] as string),
        detalle: enCarga.get(huellas[i] as string) ?? '',
      });
      porBeneficio.set(p.beneficioId, lista);
    });
    let generadas = 0;
    for (const [beneficioId, lista] of porBeneficio) {
      const relevantes = lista.filter(
        (x) =>
          estructura.aplicaA === 'AMBOS' ||
          (estructura.aplicaA === 'PCD' && x.rol === 'PCD') ||
          (estructura.aplicaA === 'CUIDADOR' && x.rol === 'CUIDADOR'),
      );
      let detalle: string | null = null;
      if (estructura.alertaNovedad === 'PRESENCIA') {
        const hit = relevantes.filter((x) => x.aparece);
        if (hit.length > 0) {
          detalle = hit
            .map(
              (x) =>
                `${x.rol === 'PCD' ? 'La persona con discapacidad' : 'El cuidador'} aparece en «${estructura.nombre}»${x.detalle ? `: ${x.detalle}` : ''}`,
            )
            .join('. ');
        }
      } else if (relevantes.length > 0 && relevantes.every((x) => !x.aparece)) {
        detalle = `Ninguna persona del beneficio aparece en «${estructura.nombre}» desde hace más de ${await parametrosRepo.entero(pool, 'inactividad_meses')} mes(es) de beneficio activo.`;
      }
      if (detalle === null) continue;
      if (
        await alertasCruceRepo.crear(pool, {
          cargaId,
          estructuraId: estructura.id,
          beneficioId,
          causalCodigo: estructura.causalCodigo,
          detalle: detalle.slice(0, 500),
        })
      ) {
        generadas++;
      }
    }
    if (generadas > 0) {
      await alertasRepo.crear(pool, {
        tipo: 'ALERTA_CRUCE',
        permisoDestino: PERMISO_GESTOR,
        titulo: `${generadas} alerta(s) del cruce «${estructura.nombre}»`,
        mensaje:
          'Revise las coincidencias antes de iniciar cualquier actuación: una alerta de cruce no finaliza ningún beneficio.',
        enlace: '/interno/novedades/alertas',
        clave: `CRUCE_CARGA:${cargaId}`,
      });
    }
    await bitacoraRepo.registrar(pool, {
      usuarioId: actorId,
      modulo: MODULO.NOVEDADES,
      accion: ACCION.CRUCE_ALERTA_GENERADA,
      entidad: 'cruce',
      entidadId: estructura.id,
      detalle: { cargaId, estructura: estructura.codigo, generadas },
    });
    return generadas;
  }

  async alertasCruce(f: { estado?: EstadoAlertaCruce; limit: number; offset: number }) {
    const r = await alertasCruceRepo.listar(this.deps.pool, f);
    return {
      total: r.total,
      items: r.items.map((a) => ({
        ...a,
        analizadaAt: a.analizadaAt?.toISOString() ?? null,
        creadaAt: a.creadaAt.toISOString(),
      })),
    };
  }

  /** El gestor analiza la alerta: la descarta o inicia la revocatoria (con su evidencia). */
  async analizarAlerta(
    actor: Actor,
    id: number,
    d: { accion: 'DESCARTAR' | 'INICIAR_REVOCATORIA'; observacion: string },
    archivo: ArchivoEntrada | null,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    if (d.observacion.trim().length < 10) {
      throw errorValidacion([
        {
          campo: 'observacion',
          mensaje: 'Observación: explique el análisis (mínimo 10 caracteres)',
        },
      ]);
    }
    if (d.accion === 'INICIAR_REVOCATORIA' && !archivo) {
      throw errorValidacion([
        { campo: 'archivo', mensaje: 'Evidencia: adjunte el soporte que sustenta la revocatoria' },
      ]);
    }
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const a = await alertasCruceRepo.porId(tx, id, true);
      if (!a) throw notFound('La alerta no existe', 'ALERTA_CRUCE_NO_ENCONTRADA');
      if (a.estado !== 'PENDIENTE')
        throw conflict('ALERTA_ANALIZADA', 'Esta alerta ya fue analizada.');
      let revocatoriaId: number | null = null;
      if (d.accion === 'INICIAR_REVOCATORIA') {
        const causal = a.causalCodigo
          ? await novedadesRepo.causalPorCodigo(tx, 'CAUSAL_REVOCATORIA', a.causalCodigo)
          : null;
        if (!causal) {
          throw conflict(
            'SIN_CAUSAL',
            'La alerta no tiene una causal de revocatoria asociada: inicie la revocatoria manualmente.',
          );
        }
        revocatoriaId = await this.iniciarRevocatoria(
          actor,
          a.beneficioId,
          { causalId: causal.id, descripcion: `${d.observacion.trim()} (${a.detalle})` },
          archivo as ArchivoEntrada,
          ctx,
          id,
          tx,
        );
      }
      await alertasCruceRepo.analizar(tx, id, {
        estado: d.accion === 'DESCARTAR' ? 'DESCARTADA' : 'EN_TRAMITE',
        usuarioId: actor.id,
        observacion: d.observacion.trim(),
        revocatoriaId,
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.CRUCE_ALERTA_ANALIZADA,
        entidad: 'alerta_cruce',
        entidadId: id,
        valorAnterior: { estado: 'PENDIENTE' },
        valorNuevo: {
          estado: d.accion === 'DESCARTAR' ? 'DESCARTADA' : 'EN_TRAMITE',
          revocatoriaId,
        },
        justificacion: d.observacion.trim(),
        ip: ctx.ip,
      });
    });
    return (await alertasCruceRepo.listar(pool, { limit: 200, offset: 0 })).items.find(
      (x) => x.id === id,
    );
  }

  // ---------------------------------------------------------------- plazos (alertas al gestor)

  /**
   * Genera los avisos del gestor por plazos: bloqueos con fecha de levantamiento cumplida, plazo de descargos vencido
   * y plazo para decidir una revocatoria vencido. Cada aviso se crea una sola vez mientras siga pendiente.
   */
  async revisarPlazos(): Promise<number> {
    const { pool } = this.deps;
    let nuevos = 0;
    const avisar = async (a: {
      tipo: string;
      titulo: string;
      mensaje: string;
      enlace: string;
      clave: string;
    }) => {
      const antes = await pool.query(
        `SELECT 1 FROM alertas WHERE clave = $1 AND atendida_at IS NULL`,
        [a.clave],
      );
      if (antes.rowCount) return;
      await alertasRepo.crear(pool, { ...a, permisoDestino: PERMISO_GESTOR });
      nuevos++;
    };
    for (const n of await novedadesRepo.levantamientosVencidos(pool)) {
      await avisar({
        tipo: 'LEVANTAMIENTO_PROGRAMADO',
        titulo: `Confirme la reactivación de ${n.radicado}`,
        mensaje: `Llegó la fecha de levantamiento programada (${n.fecha}). Confirme si el beneficio se reactiva.`,
        enlace: '/interno/novedades',
        clave: `BLOQUEO_LEVANTAR:${n.id}`,
      });
    }
    const plazoDecision = await parametrosRepo.entero(pool, 'plazo_decision_dias');
    for (const r of await revocatoriasRepo.enCurso(pool)) {
      if (
        r.estado === 'EN_TRASLADO' &&
        !r.sinDescargos &&
        r.venceDescargosAt &&
        r.venceDescargosAt.getTime() < Date.now()
      ) {
        await avisar({
          tipo: 'DESCARGOS_VENCIDOS',
          titulo: `Venció el plazo de descargos de ${r.radicado}`,
          mensaje:
            'Registre que no hubo descargos o los que se recibieron para poder decidir la revocatoria.',
          enlace: `/interno/novedades/revocatorias/${r.id}`,
          clave: `REV_DESCARGOS:${r.id}`,
        });
      }
      const base = r.baseDecision;
      if (
        base &&
        base.getTime() + plazoDecision * 86_400_000 < Date.now() &&
        (r.estado === 'CON_DESCARGOS' || r.sinDescargos)
      ) {
        await avisar({
          tipo: 'DECISION_VENCIDA',
          titulo: `Venció el plazo para decidir la revocatoria de ${r.radicado}`,
          mensaje: `Pasaron más de ${plazoDecision} días desde los descargos o el vencimiento de su plazo.`,
          enlace: `/interno/novedades/revocatorias/${r.id}`,
          clave: `REV_DECISION:${r.id}`,
        });
      }
    }
    return nuevos;
  }
}
