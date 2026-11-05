import { alertasRepo } from '../infrastructure/repositories/asignacion.js';
import { createHash, randomBytes } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import { calcularAvance, datosVacios } from '../domain/caracterizacion.js';
import { AVISO_PREINSCRIPCION } from '../domain/correos.js';
import { ESTADOS } from '../domain/estados.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { caracterizacionRepo } from '../infrastructure/repositories/caracterizacion.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { solicitudesRepo, tokensRepo } from '../infrastructure/repositories/solicitudes.js';
import { DataCipher } from '../infrastructure/security/crypto.js';
import { conflict, notFound } from '../shared/errors.js';
import type { ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import type { ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';

const FORMATO_FECHA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/** «06/10/2026 20:45», en hora de Colombia. */
function fechaHora(fecha: Date): string {
  const p = Object.fromEntries(FORMATO_FECHA.formatToParts(fecha).map((x) => [x.type, x.value]));
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']}`;
}

/**
 * Radicación de la solicitud (RF-CAR-04): valida que estén completos los datos obligatorios y los documentos
 * exigidos, asigna un número de radicado único con fecha y hora, cambia el estado a «Radicada» y envía la
 * notificación con el siguiente paso, el enlace de consulta y la aclaración de que no es aprobación.
 */
export class ServicioRadicacion {
  private readonly cipher: DataCipher;

  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
    private readonly documentos: ServicioDocumentos,
  ) {
    this.cipher = new DataCipher(deps.env.encryption);
  }

  /** Lo que falta para poder enviar: datos obligatorios y documentos, con el mensaje de cada uno. */
  async pendientes(solicitudId: number) {
    const { pool } = this.deps;
    const guardada = await caracterizacionRepo.obtener(pool, solicitudId, this.cipher);
    const datosGuardados = guardada?.datos ?? datosVacios();
    // Sin cuidador registrado no se pregunta por el servicio para el cuidador.
    if (!(await caracterizacionRepo.contexto(pool, solicitudId))?.cuidador) {
      datosGuardados.requiereCuidador = false;
    }
    const avance = calcularAvance(datosGuardados);
    const datos = avance.secciones.flatMap((s) =>
      s.faltantes.map((f) => ({ campo: f.campo, seccion: s.codigo, mensaje: f.mensaje })),
    );
    const lista = await this.documentos.faltantes(solicitudId);
    // Si todavía no respondió si requiere cuidador, los documentos del cuidador no se pueden evaluar.
    const docs = lista.map((d) => ({
      campo: `documento:${d.id}`,
      seccion: 'documentos' as const,
      mensaje: d.automatico
        ? this.documentos.mensajeRegimen(d.consulta)
        : `Falta cargar: ${d.nombre}`,
    }));
    return { datos, documentos: docs, completo: datos.length === 0 && docs.length === 0 };
  }

  async radicar(solicitudId: number, ctx: ContextoPeticion) {
    const { pool, ahora } = this.deps;
    const dias = await parametrosRepo.entero(pool, 'enlace_seguro_dias');
    const seguro = randomBytes(32).toString('base64url');
    // Filtro: se vuelve a consultar el régimen de salud antes de enviar.
    await this.documentos.consultarRegimen(solicitudId, ctx, true);
    // Las cartas se generan con los datos que escribió la persona, ya completos, y se adjuntan solas.
    if ((await this.pendientes(solicitudId)).datos.length === 0) {
      await this.documentos.generarCartas(solicitudId, ctx);
    }
    const resultado = await withTransaction(pool, async (tx) => {
      if (!(await caracterizacionRepo.bloquear(tx, solicitudId))) {
        throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
      }
      const solicitud = await caracterizacionRepo.contexto(tx, solicitudId);
      if (!solicitud) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');
      if (solicitud.estado === 'RADICADA') {
        const radicado = await solicitudesRepo.radicadoDe(tx, solicitudId);
        throw conflict('YA_RADICADA', 'Su solicitud ya fue radicada.', { radicado });
      }
      if (solicitud.estado !== 'CORREO_VERIFICADO') {
        throw conflict('SOLICITUD_NO_EDITABLE', 'La solicitud todavía no se puede enviar.');
      }
      const faltan = await this.pendientes(solicitudId);
      if (!faltan.completo) {
        throw errorValidacion(
          [...faltan.datos, ...faltan.documentos].map(({ campo, mensaje }) => ({ campo, mensaje })),
        );
      }
      const radicado = await solicitudesRepo.radicar(tx, solicitudId, solicitud.anio, ahora());
      await tokensRepo.crear(tx, {
        solicitudId,
        proposito: 'ENLACE_SEGURO',
        tokenHash: createHash('sha256').update(seguro).digest('hex'),
        creadoAt: ahora(),
        expiraAt: new Date(ahora().getTime() + dias * 86_400_000),
      });
      await alertasRepo.crear(tx, {
        tipo: 'CASO_RADICADO',
        permisoDestino: 'validacion.asignar',
        titulo: `Nueva solicitud radicada (${radicado.radicado})`,
        mensaje: `${solicitud.pcd.nombre} radicó su solicitud y espera que la asigne a un validador.`,
        enlace: '/interno/validacion',
        solicitudId,
        clave: `CASO_RADICADO:${solicitudId}`,
      });
      const d = ESTADOS.RADICADA;
      await this.correos.encolar(tx, {
        solicitudId,
        tipo: 'CARACTERIZACION_RADICADA',
        destinatario: solicitud.correo,
        datos: {
          nombre: solicitud.pcd.nombre,
          radicado: radicado.radicado,
          fechaRadicacion: fechaHora(radicado.radicadaAt),
          estado: d.nombre,
          siguientePaso: d.siguientePaso,
          enlaceConsulta: `${this.deps.env.frontendUrl}/consulta?token=${seguro}`,
        },
      });
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.RADICACION,
        accion: ACCION.SOLICITUD_RADICADA,
        entidad: 'solicitud',
        entidadId: solicitudId,
        solicitudId,
        valorAnterior: { estado: 'CORREO_VERIFICADO' },
        valorNuevo: { estado: 'RADICADA', radicado: radicado.radicado },
        ip: ctx.ip,
      });
      return radicado;
    });
    this.correos.despachar();
    const d = ESTADOS.RADICADA;
    return {
      radicado: resultado.radicado,
      radicadaAt: resultado.radicadaAt.toISOString(),
      estado: { codigo: 'RADICADA', nombre: d.nombre },
      explicacion: d.explicacion,
      siguientePaso: d.siguientePaso,
      aviso: AVISO_PREINSCRIPCION,
    };
  }
}
