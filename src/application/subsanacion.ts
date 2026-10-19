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
import { conflict, notFound } from '../shared/errors.js';
import type { ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
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
  ) {}

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
      await validacionRepo.asegurarYBloquear(tx, solicitudId);
      await validacionRepo.fijarSubsanado(tx, solicitudId, true, true);
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
