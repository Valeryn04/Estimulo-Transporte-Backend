import { createHash, randomBytes } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import { ESTADOS } from '../domain/estados.js';
import {
  enmascararCorreo,
  errorNumeroIdentificacion,
  normalizarNombre,
  normalizarNumero,
} from '../domain/identificacion.js';
import { memoriaPublica } from '../infrastructure/cache.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { autorizacionRepo } from '../infrastructure/repositories/parametrosAdmin.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { solicitudesRepo, tokensRepo } from '../infrastructure/repositories/solicitudes.js';
import { conflict, AppError, badRequest } from '../shared/errors.js';
import type { ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import { errorValidacion } from './esquemas.js';

/** Un envío más rápido que esto desde que se abrió el formulario no lo hace una persona (RNF-04). */
const SEGUNDOS_MINIMOS_FORMULARIO = 3;
/** Un formulario abierto hace más tiempo que esto se considera vencido. */
const HORAS_MAXIMAS_FORMULARIO = 2;
/** Máximo de enlaces de verificación enviados por solicitud en 24 horas. */
const MAX_REENVIOS_DIA = 5;

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');
const nuevoToken = () => randomBytes(32).toString('base64url');

export interface DatosPreinscripcion {
  pcdNombre: string;
  pcdTipoIdentificacionId: number;
  pcdNumero: string;
  /** Falso cuando la persona no tiene cuidador; entonces no se piden los datos del cuidador. */
  tieneCuidador?: boolean;
  cuidadorNombre?: string;
  cuidadorTipoIdentificacionId?: number;
  cuidadorNumero?: string;
  direccion?: string | null;
  localidadId?: number | null;
  barrioId?: number | null;
  correo: string;
  autorizacionVersion: number;
  formularioToken: string;
  /** Campo trampa: las personas no lo ven ni lo llenan. */
  contactoAlterno?: string;
}

export interface ContextoPublico extends ContextoPeticion {
  userAgent: string | null;
}

/** Preinscripción en el portal ciudadano y verificación del correo (RF-PRE-01 a RF-PRE-04). */
export class ServicioPreinscripcion {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
  ) {}

  private enlace(ruta: string, token: string): string {
    return `${this.deps.env.frontendUrl}${ruta}?token=${encodeURIComponent(token)}`;
  }

  /** Datos que necesita el formulario: catálogos activos, texto de autorización vigente y token anti-automatización. */
  async formulario() {
    const { pool, tokens, ahora } = this.deps;
    const vigencia = await solicitudesRepo.vigenciaActiva(pool);
    const { tipos, localidades, barrios, textos } = await memoriaPublica.obtener(
      'formulario',
      async () => {
        const [tipos, localidades, barrios, textos] = await Promise.all([
          solicitudesRepo.catalogoActivo(pool, 'TIPO_IDENTIFICACION'),
          solicitudesRepo.catalogoActivo(pool, 'LOCALIDAD'),
          solicitudesRepo.catalogoActivo(pool, 'BARRIO'),
          autorizacionRepo.listar(pool),
        ]);
        return { tipos, localidades, barrios, textos };
      },
    );
    const vigente = textos[0];
    return {
      abierta: vigencia?.abierta ?? false,
      anio: vigencia?.anio ?? null,
      tiposIdentificacion: tipos.map((t) => ({ id: t.id, codigo: t.codigo, nombre: t.nombre })),
      localidades: localidades.map((l) => ({ id: l.id, nombre: l.nombre })),
      barrios: barrios.map((b) => ({ id: b.id, nombre: b.nombre, localidadId: b.padreId })),
      autorizacion: vigente ? { version: vigente.version, contenido: vigente.contenido } : null,
      formularioToken: tokens.firmarFormulario(ahora().getTime()),
    };
  }

  private verificarAntiAutomatizacion(d: DatosPreinscripcion): void {
    const rechazo = () =>
      badRequest(
        'FORMULARIO_INVALIDO',
        'No pudimos procesar el envío. Recargue la página e intente de nuevo.',
      );
    if (d.contactoAlterno) throw rechazo();
    const abiertoEn = this.deps.tokens.verificarFormulario(d.formularioToken);
    if (abiertoEn === null) throw rechazo();
    const transcurrido = this.deps.ahora().getTime() - abiertoEn;
    if (transcurrido < SEGUNDOS_MINIMOS_FORMULARIO * 1000) throw rechazo();
    if (transcurrido > HORAS_MAXIMAS_FORMULARIO * 3_600_000) throw rechazo();
  }

  async preinscribir(d: DatosPreinscripcion, ctx: ContextoPublico) {
    const { pool } = this.deps;
    this.verificarAntiAutomatizacion(d);

    const vigencia = await solicitudesRepo.vigenciaActiva(pool);
    if (!vigencia || !vigencia.abierta) {
      throw conflict(
        'PREINSCRIPCION_CERRADA',
        'Por ahora no se están recibiendo preinscripciones. Consulte la página institucional del programa.',
      );
    }
    const textos = await autorizacionRepo.listar(pool);
    if (!textos[0] || textos[0].version !== d.autorizacionVersion) {
      throw conflict(
        'AUTORIZACION_CAMBIO',
        'El texto de la autorización de datos cambió. Léalo de nuevo y acéptelo para continuar.',
      );
    }

    // Validaciones de calidad de datos (RNF-10): formato por tipo de documento, catálogos cerrados y consistencia.
    const errores: { campo: string; mensaje: string }[] = [];
    const pcdTipo = await solicitudesRepo.itemActivo(
      pool,
      d.pcdTipoIdentificacionId,
      'TIPO_IDENTIFICACION',
    );
    const conCuidador = d.tieneCuidador !== false;
    const cuiTipo = conCuidador
      ? await solicitudesRepo.itemActivo(
          pool,
          d.cuidadorTipoIdentificacionId ?? 0,
          'TIPO_IDENTIFICACION',
        )
      : null;
    const pcdNumero = normalizarNumero(d.pcdNumero);
    const cuiNumero = normalizarNumero(d.cuidadorNumero ?? '');
    if (!pcdTipo)
      errores.push({
        campo: 'pcdTipoIdentificacionId',
        mensaje:
          'Tipo de identificación de la persona con discapacidad: elija una opción de la lista',
      });
    else {
      const e = errorNumeroIdentificacion(pcdTipo.codigo, pcdNumero);
      if (e)
        errores.push({
          campo: 'pcdNumero',
          mensaje: `Número de identificación de la persona con discapacidad: ${e.toLowerCase()}`,
        });
    }
    if (conCuidador && !cuiTipo)
      errores.push({
        campo: 'cuidadorTipoIdentificacionId',
        mensaje: 'Tipo de identificación del cuidador: elija una opción de la lista',
      });
    else if (cuiTipo) {
      const e = errorNumeroIdentificacion(cuiTipo.codigo, cuiNumero);
      if (e)
        errores.push({
          campo: 'cuidadorNumero',
          mensaje: `Número de identificación del cuidador: ${e.toLowerCase()}`,
        });
    }
    if (pcdTipo && cuiTipo && pcdTipo.id === cuiTipo.id && pcdNumero === cuiNumero) {
      errores.push({
        campo: 'cuidadorNumero',
        mensaje:
          'Número de identificación del cuidador: no puede ser el mismo de la persona con discapacidad',
      });
    }
    let localidadId: number | null = null;
    let barrioId: number | null = null;
    if (d.barrioId && !d.localidadId) {
      errores.push({
        campo: 'localidadId',
        mensaje: 'Localidad: seleccione la localidad del barrio',
      });
    }
    if (d.localidadId) {
      const loc = await solicitudesRepo.itemActivo(pool, d.localidadId, 'LOCALIDAD');
      if (!loc)
        errores.push({ campo: 'localidadId', mensaje: 'Localidad: elija una opción de la lista' });
      else localidadId = loc.id;
    }
    if (d.barrioId && localidadId) {
      const barrio = await solicitudesRepo.itemActivo(pool, d.barrioId, 'BARRIO');
      if (!barrio || barrio.padreId !== localidadId) {
        errores.push({
          campo: 'barrioId',
          mensaje: 'Barrio: elija un barrio de la localidad seleccionada',
        });
      } else barrioId = barrio.id;
    }
    if (errores.length > 0) throw errorValidacion(errores);

    const correo = d.correo.trim().toLowerCase();
    const token = nuevoToken();
    const horas = await parametrosRepo.entero(pool, 'verificacion_correo_horas');
    const nombrePcd = normalizarNombre(d.pcdNombre);

    const solicitudId = await withTransaction(pool, async (tx) => {
      const pcdId = await solicitudesRepo.personaParaIdentificacion(
        tx,
        (pcdTipo as { id: number }).id,
        pcdNumero,
        nombrePcd,
      );
      const cuidadorId = cuiTipo
        ? await solicitudesRepo.personaParaIdentificacion(
            tx,
            cuiTipo.id,
            cuiNumero,
            normalizarNombre(d.cuidadorNombre ?? ''),
          )
        : null;
      if (await solicitudesRepo.porPcd(tx, vigencia.id, pcdId)) throw solicitudExistente();
      let id: number;
      try {
        id = await solicitudesRepo.crear(tx, {
          vigenciaId: vigencia.id,
          pcdId,
          cuidadorId,
          direccion: d.direccion?.trim() || null,
          localidadId,
          barrioId,
          correo,
        });
      } catch (error) {
        // Dos envíos simultáneos de la misma persona: gana el primero.
        if ((error as { constraint?: string }).constraint === 'uq_solicitud_pcd_vigencia') {
          throw solicitudExistente();
        }
        throw error;
      }
      await solicitudesRepo.registrarAceptacion(tx, {
        solicitudId: id,
        version: textos[0]!.version,
        ip: ctx.ip,
        userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      });
      await tokensRepo.crear(tx, {
        solicitudId: id,
        proposito: 'VERIFICACION_CORREO',
        tokenHash: sha256(token),
        creadoAt: this.deps.ahora(),
        expiraAt: new Date(this.deps.ahora().getTime() + horas * 3_600_000),
      });
      await this.correos.encolar(tx, {
        solicitudId: id,
        tipo: 'PREINSCRIPCION_VERIFICACION',
        destinatario: correo,
        datos: {
          nombre: nombrePcd,
          enlaceVerificacion: this.enlace('/verificar-correo', token),
          horasVigencia: horas,
        },
      });
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.PREINSCRIPCION,
        accion: ACCION.SOLICITUD_PREINSCRITA,
        entidad: 'solicitud',
        entidadId: id,
        solicitudId: id,
        valorNuevo: { estado: 'PREINSCRITA', vigencia: vigencia.anio },
        detalle: { autorizacionVersion: textos[0]!.version },
        ip: ctx.ip,
      });
      return id;
    });
    this.correos.despachar();
    return {
      solicitudId,
      correoEnmascarado: enmascararCorreo(correo),
      horasVigenciaEnlace: horas,
    };
  }

  /** Verifica el correo con el enlace recibido y envía la notificación de preinscripción exitosa (RF-PRE-04). */
  async verificarCorreo(token: string, ctx: ContextoPeticion) {
    const { pool, ahora } = this.deps;
    const fila = await tokensRepo.porHash(pool, sha256(token), 'VERIFICACION_CORREO');
    if (!fila) {
      throw badRequest(
        'ENLACE_INVALIDO',
        'El enlace no es válido. Revise que esté completo o solicite uno nuevo.',
      );
    }
    const solicitud = await solicitudesRepo.porId(pool, fila.solicitudId);
    if (!solicitud) throw badRequest('ENLACE_INVALIDO', 'El enlace no es válido.');
    if (solicitud.estado !== 'PREINSCRITA') return { estado: 'YA_VERIFICADO' as const };
    if (fila.expiraAt.getTime() <= ahora().getTime()) {
      throw new AppError(
        410,
        'ENLACE_VENCIDO',
        'El enlace de verificación venció. Solicite uno nuevo para continuar.',
      );
    }
    const dias = await parametrosRepo.entero(pool, 'enlace_seguro_dias');
    const seguro = nuevoToken();
    await withTransaction(pool, async (tx) => {
      await tokensRepo.marcarUsado(tx, fila.id);
      await solicitudesRepo.marcarCorreoVerificado(tx, solicitud.id);
      await tokensRepo.crear(tx, {
        solicitudId: solicitud.id,
        proposito: 'ENLACE_SEGURO',
        tokenHash: sha256(seguro),
        creadoAt: ahora(),
        expiraAt: new Date(ahora().getTime() + dias * 86_400_000),
      });
      const d = ESTADOS.CORREO_VERIFICADO;
      await this.correos.encolar(tx, {
        solicitudId: solicitud.id,
        tipo: 'PREINSCRIPCION_EXITOSA',
        destinatario: solicitud.correo,
        datos: {
          nombre: solicitud.pcdNombre,
          estado: d.nombre,
          siguientePaso: d.siguientePaso,
          enlaceCaracterizacion: this.enlace('/caracterizacion', seguro),
          enlaceConsulta: this.enlace('/consulta', seguro),
        },
      });
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.PREINSCRIPCION,
        accion: ACCION.CORREO_VERIFICADO,
        entidad: 'solicitud',
        entidadId: solicitud.id,
        solicitudId: solicitud.id,
        valorAnterior: { estado: 'PREINSCRITA' },
        valorNuevo: { estado: 'CORREO_VERIFICADO' },
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
    return { estado: 'VERIFICADO' as const };
  }

  /**
   * Reenvía el enlace de verificación (RF-PRE-04). Responde siempre igual para no revelar si una identificación
   * tiene solicitud; limita la frecuencia para que no sirva para molestar a quien registró el correo.
   */
  async reenviarVerificacion(
    d: { tipoIdentificacionId: number; numero: string },
    ctx: ContextoPeticion,
  ): Promise<void> {
    const { pool, ahora } = this.deps;
    const vigencia = await solicitudesRepo.vigenciaActiva(pool);
    if (!vigencia) return;
    const pcdId = await solicitudesRepo.idPersona(
      pool,
      d.tipoIdentificacionId,
      normalizarNumero(d.numero),
    );
    if (!pcdId) return;
    const solicitud = await solicitudesRepo.porPcd(pool, vigencia.id, pcdId);
    if (!solicitud || solicitud.estado !== 'PREINSCRITA') return;
    const [minutos, horas, resumen] = await Promise.all([
      parametrosRepo.entero(pool, 'reenvio_verificacion_minutos'),
      parametrosRepo.entero(pool, 'verificacion_correo_horas'),
      tokensRepo.resumenVerificaciones(pool, solicitud.id),
    ]);
    if (resumen.ultimas24h >= MAX_REENVIOS_DIA) return;
    if (resumen.ultimoAt && ahora().getTime() - resumen.ultimoAt.getTime() < minutos * 60_000)
      return;
    const token = nuevoToken();
    await withTransaction(pool, async (tx) => {
      await tokensRepo.invalidarVerificaciones(tx, solicitud.id);
      await tokensRepo.crear(tx, {
        solicitudId: solicitud.id,
        proposito: 'VERIFICACION_CORREO',
        tokenHash: sha256(token),
        creadoAt: ahora(),
        expiraAt: new Date(ahora().getTime() + horas * 3_600_000),
      });
      await this.correos.encolar(tx, {
        solicitudId: solicitud.id,
        tipo: 'PREINSCRIPCION_VERIFICACION',
        destinatario: solicitud.correo,
        datos: {
          nombre: solicitud.pcdNombre,
          enlaceVerificacion: this.enlace('/verificar-correo', token),
          horasVigencia: horas,
        },
      });
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.PREINSCRIPCION,
        accion: ACCION.VERIFICACION_REENVIADA,
        entidad: 'solicitud',
        entidadId: solicitud.id,
        solicitudId: solicitud.id,
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
  }
}

function solicitudExistente(): AppError {
  return conflict(
    'SOLICITUD_EXISTENTE',
    'Ya existe una solicitud para esta persona en la vigencia actual. Puede consultar su estado.',
  );
}
