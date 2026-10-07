import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import { ENTREGA_CORREO, ESTADOS, NOMBRE_COMUNICACION } from '../domain/estados.js';
import { enmascararCorreo, normalizarNumero } from '../domain/identificacion.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { codigosRepo, consultaRepo } from '../infrastructure/repositories/consulta.js';
import { solicitudesRepo, tokensRepo } from '../infrastructure/repositories/solicitudes.js';
import { AVISO_PREINSCRIPCION } from '../domain/correos.js';
import { AppError, notFound, unauthorized } from '../shared/errors.js';
import type { ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';

/** Intentos permitidos por código antes de anularlo. */
const MAX_INTENTOS_CODIGO = 5;
/** Códigos que se pueden pedir por solicitud en una hora, y espera mínima entre uno y otro. */
const MAX_CODIGOS_HORA = 5;
const MINUTOS_ENTRE_CODIGOS = 1;
/** Duración de la sesión de consulta del ciudadano. */
const MINUTOS_SESION = 30;

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

/** Cómo la persona dice cuál es su solicitud: con la identificación de la PCD o con el número de radicado (RF-PRE-05). */
export type IdentificacionConsulta =
  { tipoIdentificacionId: number; numero: string } | { radicado: string };

export interface SesionConsulta {
  token: string;
  expiraEnMinutos: number;
}

/**
 * Consulta del estado de la solicitud (RF-PRE-05, RNF-05). La persona valida su acceso con el correo
 * registrado: un código de un solo uso enviado a ese correo, o el enlace seguro de las notificaciones. Sin esa
 * validación nunca se muestra información de la solicitud.
 */
export class ServicioConsulta {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
  ) {}

  private hashCodigo(solicitudId: number, codigo: string): string {
    return createHmac('sha256', this.deps.env.jwtSecret)
      .update(`${solicitudId}:${codigo}`)
      .digest('hex');
  }

  private buscar(d: IdentificacionConsulta) {
    const { pool } = this.deps;
    return 'radicado' in d
      ? consultaRepo.porRadicado(pool, d.radicado.trim().toUpperCase())
      : consultaRepo.ultimaDePcd(pool, d.tipoIdentificacionId, normalizarNumero(d.numero));
  }

  private sesion(solicitudId: number): SesionConsulta {
    return {
      token: this.deps.tokens.firmarCiudadano(solicitudId, MINUTOS_SESION),
      expiraEnMinutos: MINUTOS_SESION,
    };
  }

  /**
   * Envía un código de un solo uso al correo verificado de la solicitud. Responde siempre igual: no revela si la
   * identificación tiene solicitud ni cuál es el correo.
   */
  async solicitarCodigo(d: IdentificacionConsulta, ctx: ContextoPeticion): Promise<void> {
    const { pool, ahora } = this.deps;
    const solicitud = await this.buscar(d);
    // Solo se envía a un correo ya verificado (RNF-05).
    if (!solicitud || !solicitud.correoVerificadoAt) return;
    const [minutos, resumen] = await Promise.all([
      parametrosRepo.entero(pool, 'otp_vigencia_minutos'),
      codigosRepo.resumen(pool, solicitud.id, new Date(ahora().getTime() - 3_600_000)),
    ]);
    if (resumen.ultimaHora >= MAX_CODIGOS_HORA) return;
    if (
      resumen.ultimoAt &&
      ahora().getTime() - resumen.ultimoAt.getTime() < MINUTOS_ENTRE_CODIGOS * 60_000
    )
      return;
    const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await withTransaction(pool, async (tx) => {
      await codigosRepo.crear(tx, {
        solicitudId: solicitud.id,
        codigoHash: this.hashCodigo(solicitud.id, codigo),
        creadoAt: ahora(),
        expiraAt: new Date(ahora().getTime() + minutos * 60_000),
      });
      await this.correos.encolar(tx, {
        solicitudId: solicitud.id,
        tipo: 'CODIGO_CONSULTA',
        destinatario: solicitud.correo,
        datos: { nombre: solicitud.pcdNombre, codigo, minutosVigencia: minutos },
      });
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.CONSULTA,
        accion: ACCION.CONSULTA_CODIGO_SOLICITADO,
        entidad: 'solicitud',
        entidadId: solicitud.id,
        solicitudId: solicitud.id,
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
  }

  /** Valida el código y abre la sesión de consulta. Cualquier fallo responde igual (no revela qué falló). */
  async verificarCodigo(
    d: IdentificacionConsulta & { codigo: string },
    ctx: ContextoPeticion,
  ): Promise<SesionConsulta> {
    const { pool, ahora } = this.deps;
    const invalido = () =>
      new AppError(
        401,
        'CODIGO_INVALIDO',
        'El código no es válido o ya venció. Solicite uno nuevo.',
      );
    const solicitud = await this.buscar(d);
    if (!solicitud) throw invalido();
    const fila = await codigosRepo.ultimoSinUsar(pool, solicitud.id);
    if (
      !fila ||
      fila.expiraAt.getTime() <= ahora().getTime() ||
      fila.intentos >= MAX_INTENTOS_CODIGO
    ) {
      throw invalido();
    }
    const esperado = Buffer.from(fila.codigoHash);
    const recibido = Buffer.from(this.hashCodigo(solicitud.id, d.codigo));
    if (esperado.length !== recibido.length || !timingSafeEqual(esperado, recibido)) {
      await codigosRepo.sumarIntento(pool, fila.id);
      await bitacoraRepo.registrar(pool, {
        modulo: MODULO.CONSULTA,
        accion: ACCION.CONSULTA_CODIGO_FALLIDO,
        entidad: 'solicitud',
        entidadId: solicitud.id,
        solicitudId: solicitud.id,
        detalle: { intento: fila.intentos + 1 },
        ip: ctx.ip,
      });
      throw invalido();
    }
    await codigosRepo.marcarUsado(pool, fila.id, ahora());
    await bitacoraRepo.registrar(pool, {
      modulo: MODULO.CONSULTA,
      accion: ACCION.CONSULTA_ACCESO,
      entidad: 'solicitud',
      entidadId: solicitud.id,
      solicitudId: solicitud.id,
      detalle: { medio: 'CODIGO' },
      ip: ctx.ip,
    });
    return this.sesion(solicitud.id);
  }

  /** Acceso con el enlace seguro de las notificaciones (RF-PRE-05, RNF-05). */
  async accederPorEnlace(token: string, ctx: ContextoPeticion): Promise<SesionConsulta> {
    const { pool, ahora } = this.deps;
    const fila = await tokensRepo.porHash(pool, sha256(token), 'ENLACE_SEGURO');
    if (!fila) {
      throw unauthorized(
        'El enlace no es válido. Use su documento y un código enviado a su correo.',
        'ENLACE_INVALIDO',
      );
    }
    if (fila.expiraAt.getTime() <= ahora().getTime()) {
      throw unauthorized(
        'El enlace venció. Ingrese con su documento y un código enviado a su correo.',
        'ENLACE_VENCIDO',
      );
    }
    await bitacoraRepo.registrar(pool, {
      modulo: MODULO.CONSULTA,
      accion: ACCION.CONSULTA_ACCESO,
      entidad: 'solicitud',
      entidadId: fila.solicitudId,
      solicitudId: fila.solicitudId,
      detalle: { medio: 'ENLACE' },
      ip: ctx.ip,
    });
    return this.sesion(fila.solicitudId);
  }

  /** Estado de la solicitud para la persona ya validada: etapa, estado, explicación, siguiente paso y comunicaciones. */
  async consultar(solicitudId: number) {
    const { pool } = this.deps;
    const s = await consultaRepo.detalle(pool, solicitudId);
    if (!s) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
    const d = ESTADOS[s.estado];
    const comunicaciones = await consultaRepo.comunicaciones(pool, solicitudId);
    return {
      vigencia: s.anio,
      personaConDiscapacidad: s.pcdNombre,
      correo: enmascararCorreo(s.correo),
      fechaPreinscripcion: s.createdAt.toISOString(),
      radicado: s.radicado,
      fechaRadicacion: s.radicadaAt?.toISOString() ?? null,
      etapa: d.etapa,
      estado: { codigo: s.estado, nombre: d.nombre },
      explicacion: d.explicacion,
      siguientePaso: d.siguientePaso,
      aviso: AVISO_PREINSCRIPCION,
      comunicaciones: comunicaciones.map((c) => ({
        id: c.id,
        nombre: NOMBRE_COMUNICACION[c.tipo] ?? 'Comunicación',
        asunto: c.asunto,
        enviadoAt: c.creadoAt.toISOString(),
        entrega: ENTREGA_CORREO[c.estado] ?? c.estado,
      })),
    };
  }

  /** Verifica que la solicitud siga existiendo para la sesión del ciudadano. */
  async existe(solicitudId: number): Promise<boolean> {
    return (await solicitudesRepo.porId(this.deps.pool, solicitudId)) !== null;
  }
}
