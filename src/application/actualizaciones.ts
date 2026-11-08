import { ACCION, MODULO } from '../domain/acciones.js';
import { esDireccionEstandar, MENSAJE_DIRECCION } from '../domain/direccion.js';
import {
  errorNumeroIdentificacion,
  normalizarNombre,
  normalizarNumero,
} from '../domain/identificacion.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { actualizacionesRepo } from '../infrastructure/repositories/actualizaciones.js';
import { entregasRepo } from '../infrastructure/repositories/entregas.js';
import { novedadesRepo } from '../infrastructure/repositories/novedades.js';
import { solicitudesRepo } from '../infrastructure/repositories/solicitudes.js';
import { conflict, notFound } from '../shared/errors.js';
import type { ServicioAsignacion } from './asignacion.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import type { ArchivoEntrada, ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';

const FECHA = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });

export type DatosActualizacion =
  | {
      dato: 'DIRECCION';
      justificacion: string;
      direccion: string;
      localidadId: number;
      barrioId: number;
    }
  | { dato: 'CORREO'; justificacion: string; correo: string }
  | {
      dato: 'CUIDADOR';
      justificacion: string;
      tipoIdentificacionId: number;
      numeroIdentificacion: string;
      nombre: string;
    };

/**
 * Finalización del beneficio y actualización de datos de la persona beneficiaria (RF-BEN-05). Cada novedad exige
 * soporte y justificación, conserva el valor anterior y la finalización libera el cupo y alerta al asignador.
 */
export class ServicioActualizaciones {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
    private readonly documentos: ServicioDocumentos,
    private readonly asignacion: ServicioAsignacion,
  ) {}

  /** Finaliza el beneficio por una causal del catálogo y libera el cupo. */
  async finalizar(
    actor: Actor,
    beneficioId: number,
    d: { causalId: number; fechaEfectiva: string; observacion: string },
    archivo: ArchivoEntrada | null,
    ctx: ContextoPeticion,
  ): Promise<void> {
    const { pool } = this.deps;
    if (d.observacion.trim().length < 10) {
      throw errorValidacion([
        {
          campo: 'observacion',
          mensaje: 'Justificación: explique la finalización (mínimo 10 caracteres)',
        },
      ]);
    }
    const evidencia = archivo
      ? await this.documentos.guardarEvidencia(`novedades/${beneficioId}`, archivo)
      : null;
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const b = await entregasRepo.beneficio(tx, beneficioId, true);
      if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
      if (b.estado === 'FINALIZADO') {
        throw conflict('BENEFICIO_FINALIZADO', 'El beneficio ya está finalizado.');
      }
      const problemas: { campo: string; mensaje: string }[] = [];
      const causal = await novedadesRepo.causalDe(tx, 'CAUSAL_FINALIZACION', d.causalId);
      if (!causal) problemas.push({ campo: 'causalId', mensaje: 'Causal: elija una de la lista' });
      if (d.fechaEfectiva < b.asignadoDia) {
        problemas.push({
          campo: 'fechaEfectiva',
          mensaje: 'Fecha efectiva: no puede ser anterior a la asignación',
        });
      }
      if (problemas.length > 0 || !causal) throw errorValidacion(problemas);

      // Una revocatoria en curso se resuelve por su propio trámite: no se finaliza el beneficio por fuera de él.
      const abierta = await tx.query(
        `SELECT 1 FROM revocatorias WHERE beneficio_id = $1 AND estado <> 'DECIDIDA'`,
        [beneficioId],
      );
      if (abierta.rowCount) {
        throw conflict(
          'REVOCATORIA_ABIERTA',
          'Este beneficio tiene una revocatoria en curso: decídala antes de registrar la finalización.',
        );
      }
      const correoId = await this.correos.encolar(tx, {
        solicitudId: b.solicitudId,
        tipo: 'FINALIZACION_BENEFICIO',
        destinatario: b.correo,
        datos: {
          nombre: b.pcdNombre,
          radicado: b.radicado,
          causal: causal.nombre,
          fechaEfectiva: FECHA.format(new Date(`${d.fechaEfectiva}T00:00:00Z`)),
          observacion: d.observacion.trim(),
          enlaceConsulta: await this.correos.enlaceConsulta(tx, b.solicitudId),
        },
      });
      const id = await novedadesRepo.crear(tx, {
        beneficioId,
        tipo: 'FINALIZACION',
        causalId: d.causalId,
        fechaEfectiva: d.fechaEfectiva,
        observacion: d.observacion.trim(),
        evidencia,
        usuarioId: actor.id,
        levantamientoProgramado: null,
        levantaNovedadId: null,
        estadoPrevio: b.estado,
        correoId,
      });
      await this.asignacion.liberarCupo(
        tx,
        actor.id,
        beneficioId,
        `Finalización (${causal.nombre})`,
        ctx,
      );
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.BENEFICIO_FINALIZADO,
        entidad: 'novedad',
        entidadId: id,
        solicitudId: b.solicitudId,
        valorAnterior: { estado: b.estado },
        valorNuevo: { estado: 'FINALIZADO', causal: causal.nombre },
        justificacion: d.observacion.trim(),
        detalle: {
          beneficioId,
          fechaEfectiva: d.fechaEfectiva,
          evidencia: evidencia?.nombre ?? null,
          sha256: evidencia?.sha256 ?? null,
          correoId,
        },
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
  }

  /** Cambia la dirección, el correo o el cuidador del beneficiario con soporte y justificación. */
  async actualizarDatos(
    actor: Actor,
    beneficioId: number,
    d: DatosActualizacion,
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
  ): Promise<void> {
    const { pool } = this.deps;
    if (d.justificacion.trim().length < 10) {
      throw errorValidacion([
        {
          campo: 'justificacion',
          mensaje: 'Justificación: explique el cambio (mínimo 10 caracteres)',
        },
      ]);
    }
    const evidencia = await this.documentos.guardarEvidencia(`novedades/${beneficioId}`, archivo);
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const b = await entregasRepo.beneficio(tx, beneficioId, true);
      if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
      if (b.estado === 'FINALIZADO') {
        throw conflict('BENEFICIO_FINALIZADO', 'El beneficio ya está finalizado.');
      }
      const s = await actualizacionesRepo.solicitud(tx, b.solicitudId);
      if (!s) throw notFound('La solicitud no existe', 'SOLICITUD_NO_ENCONTRADA');

      let anterior: unknown;
      let nuevo: unknown;
      if (d.dato === 'DIRECCION') {
        const problemas: { campo: string; mensaje: string }[] = [];
        const direccion = d.direccion.trim();
        if (!esDireccionEstandar(direccion)) {
          problemas.push({ campo: 'direccion', mensaje: MENSAJE_DIRECCION });
        }
        if (!(await actualizacionesRepo.barrioDeLocalidad(tx, d.localidadId, d.barrioId))) {
          problemas.push({ campo: 'barrioId', mensaje: 'Barrio: elija un barrio de la localidad' });
        }
        if (problemas.length > 0) throw errorValidacion(problemas);
        anterior = { direccion: s.direccion, localidad: s.localidad, barrio: s.barrio };
        await actualizacionesRepo.aplicarDireccion(tx, b.solicitudId, {
          direccion,
          localidadId: d.localidadId,
          barrioId: d.barrioId,
        });
        const nueva = await actualizacionesRepo.solicitud(tx, b.solicitudId);
        nuevo = { direccion, localidad: nueva?.localidad, barrio: nueva?.barrio };
      } else if (d.dato === 'CORREO') {
        const correo = d.correo.trim().toLowerCase();
        if (correo === s.correo.toLowerCase()) {
          throw errorValidacion([
            { campo: 'correo', mensaje: 'Correo: es el mismo que ya está registrado' },
          ]);
        }
        anterior = { correo: s.correo };
        nuevo = { correo };
        await actualizacionesRepo.aplicarCorreo(tx, b.solicitudId, correo);
      } else {
        if (b.personas !== 2 || !(await actualizacionesRepo.tieneCuidador(tx, beneficioId))) {
          throw conflict('SIN_CUIDADOR', 'Este beneficio no incluye a un cuidador.');
        }
        const tipo = await tx.query<{ codigo: string }>(
          `SELECT codigo FROM catalogo_items WHERE id = $1 AND catalogo = 'TIPO_IDENTIFICACION' AND activo`,
          [d.tipoIdentificacionId],
        );
        const numero = normalizarNumero(d.numeroIdentificacion);
        const problemas: { campo: string; mensaje: string }[] = [];
        if (!tipo.rows[0]) {
          problemas.push({
            campo: 'tipoIdentificacionId',
            mensaje: 'Tipo de identificación: elija una opción',
          });
        } else {
          const e = errorNumeroIdentificacion(tipo.rows[0].codigo, numero);
          if (e)
            problemas.push({
              campo: 'numeroIdentificacion',
              mensaje: `Número de identificación: ${e}`,
            });
        }
        const nombre = normalizarNombre(d.nombre);
        if (nombre.length < 3) {
          problemas.push({ campo: 'nombre', mensaje: 'Nombre: escriba al menos 3 caracteres' });
        }
        if (problemas.length > 0) throw errorValidacion(problemas);
        const personaId = await solicitudesRepo.personaParaIdentificacion(
          tx,
          d.tipoIdentificacionId,
          numero,
          nombre,
        );
        if (personaId === s.pcd_id) {
          throw errorValidacion([
            {
              campo: 'numeroIdentificacion',
              mensaje: 'El cuidador no puede ser la persona con discapacidad',
            },
          ]);
        }
        if (personaId === s.cuidador_id) {
          throw errorValidacion([
            {
              campo: 'numeroIdentificacion',
              mensaje: 'Es el mismo cuidador que ya está registrado',
            },
          ]);
        }
        // RN-01: una persona solo puede recibir un beneficio vigente.
        const ocupado = await tx.query(
          `SELECT 1 FROM beneficio_personas WHERE persona_id = $1 AND vigente`,
          [personaId],
        );
        if (ocupado.rowCount) {
          throw conflict(
            'CUIDADOR_CON_BENEFICIO',
            'Esa persona ya recibe otro beneficio vigente y solo puede recibir uno.',
          );
        }
        anterior = {
          nombre: s.cuidador_nombre,
          identificacion: `${s.cuidador_tipo} ${s.cuidador_numero}`,
        };
        nuevo = { nombre, identificacion: `${tipo.rows[0]?.codigo} ${numero}` };
        await actualizacionesRepo.cambiarCuidador(tx, b.solicitudId, beneficioId, personaId);
      }

      const id = await actualizacionesRepo.crear(tx, {
        beneficioId,
        dato: d.dato,
        anterior,
        nuevo,
        justificacion: d.justificacion.trim(),
        evidencia,
        usuarioId: actor.id,
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.NOVEDADES,
        accion: ACCION.DATOS_ACTUALIZADOS,
        entidad: 'novedad_datos',
        entidadId: id,
        solicitudId: b.solicitudId,
        valorAnterior: { dato: d.dato, valor: anterior },
        valorNuevo: { dato: d.dato, valor: nuevo },
        justificacion: d.justificacion.trim(),
        detalle: { beneficioId, evidencia: evidencia.nombre, sha256: evidencia.sha256 },
        ip: ctx.ip,
      });
    });
  }

  async evidencia(id: number) {
    const e = await actualizacionesRepo.evidencia(this.deps.pool, id);
    if (!e) throw notFound('La actualización no existe', 'ACTUALIZACION_NO_ENCONTRADA');
    return this.documentos.leerEvidencia(e);
  }
}
