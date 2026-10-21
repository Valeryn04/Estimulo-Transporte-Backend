import { ACCION, MODULO } from '../domain/acciones.js';
import {
  PATRON_TARJETA,
  enmascararTarjeta,
  estadoTrasEntrega,
  normalizarTarjeta,
  rolesPendientes,
  type RolBeneficiario,
  type TipoReceptor,
} from '../domain/entrega.js';
import { normalizarNumero } from '../domain/identificacion.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { entregasRepo } from '../infrastructure/repositories/entregas.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import type { ArchivoEntrada, ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';

export interface EntregaEntrada {
  rol: RolBeneficiario;
  tarjetaId: string;
  tipoTransporteId: number;
  fechaEntrega: string;
  receptorTipo: TipoReceptor;
  receptorNombre?: string;
  receptorTipoIdentificacionId?: number;
  receptorNumero?: string;
  funcionarioEntrega: string;
}

const ESTADOS_CON_ENTREGA: readonly string[] = [
  'PENDIENTE_ENTREGA',
  'PENDIENTE_ACTIVACION',
  'ACTIVO',
];
const FECHA = new Intl.DateTimeFormat('es-CO', { dateStyle: 'long', timeZone: 'UTC' });

/**
 * Entrega del medio de transporte y activación del beneficio (RF-ASI-05, RF-ASI-06). Cada persona del beneficio recibe
 * su tarjeta: se registra el identificador (único entre beneficios vigentes), el receptor, el soporte y el funcionario.
 * Con todas las entregas, el beneficio queda activo o pendiente de activación según el procedimiento configurado.
 */
export class ServicioEntregas {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
    private readonly documentos: ServicioDocumentos,
  ) {}

  async detalle(beneficioId: number) {
    const { pool } = this.deps;
    const b = await entregasRepo.beneficio(pool, beneficioId);
    if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
    const [personas, entregas, opciones] = await Promise.all([
      entregasRepo.personas(pool, beneficioId),
      entregasRepo.entregas(pool, beneficioId),
      entregasRepo.opciones(pool),
    ]);
    const entregados = entregas.filter((e) => e.vigente).map((e) => e.rol);
    return {
      beneficio: {
        id: b.id,
        solicitudId: b.solicitudId,
        radicado: b.radicado,
        estado: b.estado,
        personas: b.personas,
        pcdNombre: b.pcdNombre,
        asignadoAt: b.asignadoAt.toISOString(),
        activadoAt: b.activadoAt?.toISOString() ?? null,
        hoy: b.hoy,
        asignadoDia: b.asignadoDia,
      },
      personas: personas.map((p) => ({
        rol: p.rol,
        nombre: p.nombre,
        tipoIdentificacion: p.tipoIdentificacion,
        numero: p.numero,
      })),
      // Tras un cambio de cuidador, la tarjeta del nuevo se entrega aunque el beneficio ya esté activo.
      pendientes: ESTADOS_CON_ENTREGA.includes(b.estado)
        ? rolesPendientes(b.personas, entregados)
        : [],
      entregas: entregas.map((e) => ({
        id: e.id,
        rol: e.rol,
        tarjeta: enmascararTarjeta(e.tarjetaId),
        tipoTransporte: e.tipoTransporte,
        fechaEntrega: e.fechaEntrega,
        receptorTipo: e.receptorTipo,
        receptorNombre: e.receptorNombre,
        receptorTipoIdentificacion: e.receptorTipoIdentificacion,
        receptorNumero: e.receptorNumero,
        funcionarioEntrega: e.funcionarioEntrega,
        soporte: e.soporte,
        vigente: e.vigente,
        registradoPor: e.registradoPor,
        registradoAt: e.registradoAt.toISOString(),
      })),
      opciones,
    };
  }

  /** Registra la entrega de la tarjeta a una de las personas del beneficio. */
  async registrar(
    actor: Actor,
    beneficioId: number,
    d: EntregaEntrada,
    archivo: ArchivoEntrada,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const tarjetaId = normalizarTarjeta(d.tarjetaId);
    const errores: { campo: string; mensaje: string }[] = [];
    if (!PATRON_TARJETA.test(tarjetaId)) {
      errores.push({
        campo: 'tarjetaId',
        mensaje: 'Identificador de la tarjeta: use de 4 a 30 letras, números o guiones',
      });
    }
    if (d.receptorTipo === 'TERCERO') {
      if ((d.receptorNombre ?? '').trim().length < 3) {
        errores.push({ campo: 'receptorNombre', mensaje: 'Nombre de quien recibe: escríbalo' });
      }
      if (!d.receptorTipoIdentificacionId) {
        errores.push({
          campo: 'receptorTipoIdentificacionId',
          mensaje: 'Tipo de documento de quien recibe: elíjalo',
        });
      }
      if (!/^[A-Z0-9]{4,20}$/.test(normalizarNumero(d.receptorNumero ?? ''))) {
        errores.push({
          campo: 'receptorNumero',
          mensaje: 'Número de documento de quien recibe: use de 4 a 20 letras o números',
        });
      }
    }
    if (errores.length > 0) throw errorValidacion(errores);
    // El archivo se valida y guarda antes de abrir la transacción.
    const soporte = await this.documentos.guardarEvidencia(`entregas/${beneficioId}`, archivo);
    const activacionInmediata =
      (await parametrosRepo.texto(pool, 'entrega_activacion_inmediata')) === 'true';

    const resultado = await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const b = await entregasRepo.beneficio(tx, beneficioId, true);
      if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
      if (!ESTADOS_CON_ENTREGA.includes(b.estado)) {
        throw conflict('BENEFICIO_NO_PENDIENTE', 'Este beneficio ya no está pendiente de entrega.');
      }
      const reposicion = b.estado !== 'PENDIENTE_ENTREGA';
      const personas = await entregasRepo.personas(tx, beneficioId);
      const entregas = (await entregasRepo.entregas(tx, beneficioId)).filter((e) => e.vigente);
      const persona = personas.find((p) => p.rol === d.rol);
      if (!persona) {
        throw errorValidacion([
          { campo: 'rol', mensaje: 'Persona: este beneficio no incluye a esa persona' },
        ]);
      }
      if (entregas.some((e) => e.rol === d.rol)) {
        throw conflict('ENTREGA_YA_REGISTRADA', 'A esa persona ya se le registró la entrega.');
      }
      const problemas: { campo: string; mensaje: string }[] = [];
      if (d.fechaEntrega > b.hoy) {
        problemas.push({ campo: 'fechaEntrega', mensaje: 'Fecha de entrega: no puede ser futura' });
      }
      if (d.fechaEntrega < b.asignadoDia) {
        problemas.push({
          campo: 'fechaEntrega',
          mensaje: 'Fecha de entrega: no puede ser anterior a la asignación del beneficio',
        });
      }
      if (!(await entregasRepo.transporteExiste(tx, d.tipoTransporteId))) {
        problemas.push({
          campo: 'tipoTransporteId',
          mensaje: 'Tipo de transporte: elija uno de la lista',
        });
      }
      if (
        d.receptorTipo === 'TERCERO' &&
        !(await entregasRepo.identificacionExiste(tx, d.receptorTipoIdentificacionId as number))
      ) {
        problemas.push({
          campo: 'receptorTipoIdentificacionId',
          mensaje: 'Tipo de documento: elija uno de la lista',
        });
      }
      const receptor = personas.find((p) => p.rol === d.receptorTipo);
      if (d.receptorTipo !== 'TERCERO' && !receptor) {
        problemas.push({
          campo: 'receptorTipo',
          mensaje: 'Receptor: este beneficio no incluye a esa persona',
        });
      }
      if (problemas.length > 0) throw errorValidacion(problemas);

      let id: number;
      try {
        id = await entregasRepo.crear(tx, {
          beneficioId,
          rol: d.rol,
          tarjetaId,
          tipoTransporteId: d.tipoTransporteId,
          fechaEntrega: d.fechaEntrega,
          receptorTipo: d.receptorTipo,
          receptorNombre: receptor ? receptor.nombre : (d.receptorNombre as string).trim(),
          receptorTipoIdentificacionId: receptor
            ? receptor.tipoIdentificacionId
            : (d.receptorTipoIdentificacionId as number),
          receptorNumero: receptor ? receptor.numero : normalizarNumero(d.receptorNumero as string),
          funcionarioEntrega: d.funcionarioEntrega.trim(),
          soporte,
          usuarioId: actor.id,
        });
      } catch (error) {
        const e = error as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'uq_tarjeta_vigente') {
          throw conflict(
            'TARJETA_EN_USO',
            'Ese identificador de tarjeta ya está asignado a otro beneficiario activo.',
          );
        }
        throw error;
      }
      const pendientes = rolesPendientes(b.personas, [...entregas.map((e) => e.rol), d.rol]);
      const estado = reposicion
        ? (b.estado as 'PENDIENTE_ACTIVACION' | 'ACTIVO')
        : estadoTrasEntrega(pendientes.length, activacionInmediata);
      if (!reposicion && estado !== 'PENDIENTE_ENTREGA') {
        await entregasRepo.fijarEstado(tx, beneficioId, estado, estado === 'ACTIVO');
      }
      const [recomendaciones, causales, transporte] = await Promise.all([
        parametrosRepo.texto(tx, 'entrega_recomendaciones'),
        entregasRepo.causalesRevocatoria(tx),
        entregasRepo.opciones(tx),
      ]);
      await this.correos.encolar(tx, {
        solicitudId: b.solicitudId,
        tipo: 'ENTREGA_REGISTRADA',
        destinatario: b.correo,
        datos: {
          nombre: persona.nombre,
          radicado: b.radicado,
          fechaEntrega: FECHA.format(new Date(`${d.fechaEntrega}T00:00:00Z`)),
          tarjetaEnmascarada: enmascararTarjeta(tarjetaId),
          tipoTransporte:
            transporte.tiposTransporte.find((t) => t.id === d.tipoTransporteId)?.nombre ?? '',
          recomendacionesUso: recomendaciones,
          causalesRevocatoria: causales.map((c) => `- ${c}`).join('\n'),
          enlaceConsulta: await this.correos.enlaceConsulta(tx, b.solicitudId),
        },
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ASIGNACION,
        accion: ACCION.ENTREGA_REGISTRADA,
        entidad: 'entrega',
        entidadId: id,
        solicitudId: b.solicitudId,
        valorAnterior: { estado: b.estado },
        valorNuevo: { estado, rol: d.rol, tarjeta: enmascararTarjeta(tarjetaId) },
        detalle: {
          beneficioId,
          receptorTipo: d.receptorTipo,
          funcionarioEntrega: d.funcionarioEntrega.trim(),
          soporte: soporte.nombre,
          sha256: soporte.sha256,
        },
        ip: ctx.ip,
      });
      return estado;
    });
    this.correos.despachar();
    return { estado: resultado, ...(await this.detalle(beneficioId)) };
  }

  /** Confirma la activación del beneficio (cuando el procedimiento con el operador la deja pendiente). */
  async activar(actor: Actor, beneficioId: number, observacion: string, ctx: ContextoPeticion) {
    const { pool } = this.deps;
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const b = await entregasRepo.beneficio(tx, beneficioId, true);
      if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
      if (b.estado !== 'PENDIENTE_ACTIVACION') {
        throw conflict(
          'BENEFICIO_NO_PENDIENTE_ACTIVACION',
          'Este beneficio no está pendiente de activación.',
        );
      }
      await entregasRepo.fijarEstado(tx, beneficioId, 'ACTIVO', true);
      await this.correos.encolar(tx, {
        solicitudId: b.solicitudId,
        tipo: 'BENEFICIO_ACTIVADO',
        destinatario: b.correo,
        datos: {
          nombre: b.pcdNombre,
          radicado: b.radicado,
          enlaceConsulta: await this.correos.enlaceConsulta(tx, b.solicitudId),
        },
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.ASIGNACION,
        accion: ACCION.BENEFICIO_ACTIVADO,
        entidad: 'beneficio',
        entidadId: beneficioId,
        solicitudId: b.solicitudId,
        valorAnterior: { estado: 'PENDIENTE_ACTIVACION' },
        valorNuevo: { estado: 'ACTIVO' },
        justificacion: observacion.trim() || null,
        ip: ctx.ip,
      });
    });
    this.correos.despachar();
    return this.detalle(beneficioId);
  }

  /** Acta de entrega firmada (soporte), solo para quien tiene acceso a la asignación. */
  async soporte(entregaId: number) {
    const e = await entregasRepo.soporte(this.deps.pool, entregaId);
    if (!e) throw notFound('La entrega no existe', 'ENTREGA_NO_ENCONTRADA');
    return this.documentos.leerEvidencia(e);
  }
}
