import { alertasRepo } from '../infrastructure/repositories/asignacion.js';
import { createHash, randomBytes } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import { ESTADOS, type EstadoSolicitud } from '../domain/estados.js';
import { withTransaction, type Queryable } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { caracterizacionRepo } from '../infrastructure/repositories/caracterizacion.js';
import { documentosSolicitudRepo } from '../infrastructure/repositories/documentos.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { tokensRepo } from '../infrastructure/repositories/solicitudes.js';
import { validacionRepo, type ItemSubsanacion } from '../infrastructure/repositories/validacion.js';
import { textoItemsSubsanar } from '../domain/validacion.js';
import { conflict, notFound } from '../shared/errors.js';
import type { ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import type { ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';

/** Qué puede modificar la persona en su solicitud según su estado (RF-CAR-06). */
export type ModoEdicion =
  | { modo: 'TODO' }
  | { modo: 'NINGUNO' }
  | {
      modo: 'SUBSANACION';
      documentos: ReadonlySet<number>;
      campos: ReadonlySet<string>;
      subsanacionId: number;
    };

/**
 * Antes de radicar la persona edita todo su formulario. Con una subsanación vigente solo puede modificar los
 * documentos y los datos que el validador señaló. En cualquier otro estado, nada.
 */
export async function modoDeEdicion(
  db: Queryable,
  solicitudId: number,
  estado: EstadoSolicitud,
): Promise<ModoEdicion> {
  if (estado === 'CORREO_VERIFICADO') return { modo: 'TODO' };
  if (estado !== 'EN_SUBSANACION') return { modo: 'NINGUNO' };
  const sub = await validacionRepo.ultimaSubsanacion(db, solicitudId, true);
  if (!sub || sub.vencida) return { modo: 'NINGUNO' };
  return {
    modo: 'SUBSANACION',
    documentos: new Set(sub.items.map((i) => i.documentoId).filter((d): d is number => d !== null)),
    campos: new Set(sub.items.flatMap((i) => i.campos)),
    subsanacionId: sub.id,
  };
}

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

const FECHA_LARGA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

/** La subsanación vigente (o la última) con la observación del validador y el plazo. */
export async function vistaSubsanacion(db: Queryable, solicitudId: number) {
  const sub = await validacionRepo.ultimaSubsanacion(db, solicitudId);
  if (!sub) return null;
  const ctx = await caracterizacionRepo.contexto(db, solicitudId);
  const abierta = sub.estado === 'ABIERTA' && !sub.vencida && ctx?.estado === 'EN_SUBSANACION';
  return {
    estado:
      sub.estado === 'RESPONDIDA'
        ? ('RESPONDIDA' as const)
        : sub.vencida
          ? ('VENCIDA' as const)
          : ('ABIERTA' as const),
    venceAt: sub.venceAt.toISOString(),
    respondidaAt: sub.respondidaAt?.toISOString() ?? null,
    puedeResponder: abierta,
    items: sub.items.map((i: ItemSubsanacion) => ({
      nombre: i.nombre,
      observacion: i.observacion,
      documentoId: i.documentoId,
      campos: i.campos,
    })),
    documentosEditables: abierta
      ? sub.items.map((i) => i.documentoId).filter((d): d is number => d !== null)
      : [],
    camposEditables: abierta ? [...new Set(sub.items.flatMap((i) => i.campos))] : [],
  };
}

/** Lo que ve y puede hacer la persona cuando se le pidió subsanar (RF-CAR-06). */
export class ServicioSubsanacion {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
    private readonly documentos: ServicioDocumentos,
  ) {}

  /**
   * Tarea periódica sobre los plazos de subsanación: avisa a la persona unos días antes del vencimiento (RF-COM-01) y,
   * pasado el plazo sin respuesta, la solicitud pasa a «no cumple por vencimiento de término» y se le notifica (RN-12).
   */
  async revisarPlazos(): Promise<{ recordatorios: number; vencidas: number }> {
    const { pool } = this.deps;
    const dias = await parametrosRepo.entero(pool, 'subsanacion_recordatorio_dias');
    const plazoRecursos = await parametrosRepo.entero(pool, 'plazo_recursos_dias');
    let recordatorios = 0;
    let vencidas = 0;

    const porAvisar = await pool.query<{ id: string }>(
      `SELECT sub.id FROM subsanaciones sub JOIN solicitudes s ON s.id = sub.solicitud_id
        WHERE sub.estado = 'ABIERTA' AND s.estado = 'EN_SUBSANACION' AND sub.recordatorio_at IS NULL
          AND sub.vence_at > now() AND sub.vence_at <= now() + make_interval(days => $1)`,
      [dias],
    );
    for (const { id } of porAvisar.rows) {
      const hecho = await withTransaction(pool, async (tx) => {
        const r = await tx.query<{
          solicitud_id: number;
          items: ItemSubsanacion[];
          vence_at: Date;
          radicado: string;
          correo: string;
          nombre: string;
        }>(
          `SELECT sub.solicitud_id, sub.items, sub.vence_at, s.radicado, s.correo, p.nombre_completo AS nombre
             FROM subsanaciones sub JOIN solicitudes s ON s.id = sub.solicitud_id
             JOIN personas p ON p.id = s.pcd_id
            WHERE sub.id = $1 AND sub.estado = 'ABIERTA' AND sub.recordatorio_at IS NULL AND s.estado = 'EN_SUBSANACION'
            FOR UPDATE OF sub SKIP LOCKED`,
          [id],
        );
        const f = r.rows[0];
        if (!f) return false;
        const enlaceConsulta = await this.correos.enlaceConsulta(tx, f.solicitud_id, dias + 1);
        const token = new URL(enlaceConsulta).searchParams.get('token');
        await this.correos.encolar(tx, {
          solicitudId: f.solicitud_id,
          tipo: 'RECORDATORIO_SUBSANACION',
          destinatario: f.correo,
          datos: {
            nombre: f.nombre,
            radicado: f.radicado,
            itemsSubsanar: textoItemsSubsanar(f.items),
            fechaLimite: FECHA_LARGA.format(f.vence_at),
            enlaceCaracterizacion: `${this.deps.env.frontendUrl}/caracterizacion?token=${token}`,
            enlaceConsulta,
          },
        });
        await tx.query(`UPDATE subsanaciones SET recordatorio_at = now() WHERE id = $1`, [id]);
        await bitacoraRepo.registrar(tx, {
          usuarioId: null,
          modulo: MODULO.VALIDACION,
          accion: ACCION.SUBSANACION_RECORDATORIO,
          entidad: 'subsanacion',
          entidadId: id,
          solicitudId: f.solicitud_id,
          detalle: { venceAt: f.vence_at.toISOString() },
        });
        return true;
      });
      if (hecho) recordatorios++;
    }

    const vencidasIds = await pool.query<{ id: string }>(
      `SELECT sub.id FROM subsanaciones sub JOIN solicitudes s ON s.id = sub.solicitud_id
        WHERE sub.estado = 'ABIERTA' AND s.estado = 'EN_SUBSANACION' AND sub.vence_at < now()`,
    );
    for (const { id } of vencidasIds.rows) {
      const hecho = await withTransaction(pool, async (tx) => {
        const r = await tx.query<{
          solicitud_id: number;
          vence_at: Date;
          radicado: string;
          correo: string;
          nombre: string;
        }>(
          `SELECT sub.solicitud_id, sub.vence_at, s.radicado, s.correo, p.nombre_completo AS nombre
             FROM subsanaciones sub JOIN solicitudes s ON s.id = sub.solicitud_id
             JOIN personas p ON p.id = s.pcd_id
            WHERE sub.id = $1 AND sub.estado = 'ABIERTA' AND s.estado = 'EN_SUBSANACION' AND sub.vence_at < now()
            FOR UPDATE OF s SKIP LOCKED`,
          [id],
        );
        const f = r.rows[0];
        if (!f) return false;
        await validacionRepo.fijarEstado(tx, f.solicitud_id, 'NO_CUMPLE');
        const asignado = await tx.query<{ a: number | null }>(
          `SELECT asignado_a AS a FROM validaciones WHERE solicitud_id = $1`,
          [f.solicitud_id],
        );
        const validador = asignado.rows[0]?.a ?? null;
        await alertasRepo.crear(tx, {
          tipo: 'SUBSANACION_VENCIDA',
          permisoDestino: validador ? 'validacion.validar' : 'validacion.asignar',
          usuarioDestino: validador,
          titulo: `Venció el plazo de subsanación (${f.radicado})`,
          mensaje: `${f.nombre} no respondió a tiempo: la solicitud pasó a «no cumple» por vencimiento de término.`,
          enlace: `/interno/validacion/caso/${f.solicitud_id}`,
          solicitudId: f.solicitud_id,
        });
        await this.correos.encolar(tx, {
          solicitudId: f.solicitud_id,
          tipo: 'SUBSANACION_VENCIDA',
          destinatario: f.correo,
          datos: {
            nombre: f.nombre,
            radicado: f.radicado,
            fechaLimite: FECHA_LARGA.format(f.vence_at),
            plazoRecursosDias: plazoRecursos,
            enlaceConsulta: await this.correos.enlaceConsulta(
              tx,
              f.solicitud_id,
              plazoRecursos + 1,
            ),
          },
        });
        await bitacoraRepo.registrar(tx, {
          usuarioId: null,
          modulo: MODULO.VALIDACION,
          accion: ACCION.SUBSANACION_VENCIDA,
          entidad: 'solicitud',
          entidadId: f.solicitud_id,
          solicitudId: f.solicitud_id,
          valorAnterior: { estado: 'EN_SUBSANACION' },
          valorNuevo: { estado: 'NO_CUMPLE' },
          justificacion:
            'No cumple por vencimiento de término: venció el plazo de subsanación sin respuesta.',
          detalle: { subsanacionId: Number(id), venceAt: f.vence_at.toISOString() },
        });
        return true;
      });
      if (hecho) vencidas++;
    }
    if (recordatorios + vencidas > 0) this.correos.despachar();
    return { recordatorios, vencidas };
  }

  /** La subsanación vigente (o la última) con la observación del validador y el plazo. */
  obtener(solicitudId: number) {
    return vistaSubsanacion(this.deps.pool, solicitudId);
  }

  /**
   * La persona envía sus correcciones: el caso vuelve a la bandeja de validación marcado como «subsanado». Cada
   * documento señalado debe tener un archivo nuevo, y si se pidieron datos, debe haberlos corregido.
   */
  async responder(solicitudId: number, ctx: ContextoPeticion) {
    const { pool, ahora } = this.deps;
    const dias = await parametrosRepo.entero(pool, 'enlace_seguro_dias');
    const token = randomBytes(32).toString('base64url');
    // Si la persona corrigió datos, las cartas del sistema se vuelven a generar con lo nuevo.
    await this.documentos.generarCartas(solicitudId, ctx);
    await withTransaction(pool, async (tx) => {
      if (!(await caracterizacionRepo.bloquear(tx, solicitudId))) {
        throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
      }
      const solicitud = await caracterizacionRepo.contexto(tx, solicitudId);
      if (!solicitud) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
      const sub = await validacionRepo.ultimaSubsanacion(tx, solicitudId, true);
      if (solicitud.estado !== 'EN_SUBSANACION' || !sub) {
        throw conflict('SIN_SUBSANACION', 'Su solicitud no tiene correcciones pendientes.');
      }
      if (sub.vencida) {
        throw conflict(
          'SUBSANACION_VENCIDA',
          'El plazo para responder terminó. El funcionario revisará su caso.',
        );
      }
      const faltan: { campo: string; mensaje: string }[] = [];
      for (const item of sub.items) {
        if (item.documentoId !== null) {
          const vigente = await documentosSolicitudRepo.vigente(tx, solicitudId, item.documentoId);
          if (!vigente || vigente.cargadoAt.getTime() < sub.createdAt.getTime()) {
            faltan.push({
              campo: `documento:${item.documentoId}`,
              mensaje: `Cargue el documento corregido: ${item.nombre}`,
            });
          }
        } else if (item.campos.length > 0) {
          const guardada = await caracterizacionRepo.ultimaActualizacion(tx, solicitudId);
          if (!guardada || guardada.getTime() < sub.createdAt.getTime()) {
            faltan.push({ campo: 'datos', mensaje: `Corrija los datos señalados: ${item.nombre}` });
          }
        }
      }
      if (faltan.length > 0) throw errorValidacion(faltan);

      await validacionRepo.marcarRespondida(tx, sub.id);
      await validacionRepo.fijarEstado(tx, solicitudId, 'SUBSANADA');
      const validacion = await validacionRepo.asegurarYBloquear(tx, solicitudId);
      await validacionRepo.fijarSubsanado(tx, solicitudId, true, true);
      // Quien tenía el caso se entera de que la persona ya respondió; si no hay validador, el responsable.
      await alertasRepo.crear(tx, {
        tipo: 'SUBSANACION_RECIBIDA',
        permisoDestino: validacion.asignadoA ? 'validacion.validar' : 'validacion.asignar',
        usuarioDestino: validacion.asignadoA,
        titulo: `La persona respondió la subsanación (${solicitud.radicado ?? ''})`.trim(),
        mensaje: 'Ya puede revisar de nuevo el caso con lo que corrigió.',
        enlace: `/interno/validacion/caso/${solicitudId}`,
        solicitudId,
      });
      await tokensRepo.crear(tx, {
        solicitudId,
        proposito: 'ENLACE_SEGURO',
        tokenHash: sha256(token),
        creadoAt: ahora(),
        expiraAt: new Date(ahora().getTime() + dias * 86_400_000),
      });
      const d = ESTADOS.SUBSANADA;
      await this.correos.encolar(tx, {
        solicitudId,
        tipo: 'SUBSANACION_RECIBIDA',
        destinatario: solicitud.correo,
        datos: {
          nombre: solicitud.pcd.nombre,
          radicado: solicitud.radicado ?? '',
          estado: d.nombre,
          siguientePaso: d.siguientePaso,
          enlaceConsulta: `${this.deps.env.frontendUrl}/consulta?token=${token}`,
        },
      });
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.VALIDACION,
        accion: ACCION.SUBSANACION_RESPONDIDA,
        entidad: 'solicitud',
        entidadId: solicitudId,
        solicitudId,
        valorAnterior: { estado: 'EN_SUBSANACION' },
        valorNuevo: { estado: 'SUBSANADA' },
        detalle: { vencia: FECHA_LARGA.format(sub.venceAt) },
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
    const d = ESTADOS.SUBSANADA;
    return {
      estado: { codigo: 'SUBSANADA', nombre: d.nombre },
      explicacion: d.explicacion,
      siguientePaso: d.siguientePaso,
    };
  }
}
