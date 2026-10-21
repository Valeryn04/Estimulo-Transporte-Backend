import { ACCION, MODULO } from '../domain/acciones.js';
import {
  TEXTO_MOTIVO,
  casosSaltados,
  planificarAsignacion,
  redondearMoneda,
  type CandidatoAsignacion,
  type PlanCaso,
} from '../domain/asignacion.js';
import { describirCriterio, ordenarPorPrioridad, redondear } from '../domain/priorizacion.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction, type Queryable } from '../infrastructure/db/pool.js';
import {
  alertasRepo,
  asignacionRepo,
  type CandidatoFila,
  type EstadoBeneficio,
  type Finanzas,
  type ItemDistribucion,
  type TipoAjuste,
  type TipoDistribucion,
} from '../infrastructure/repositories/asignacion.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { calculosRepo, matricesRepo } from '../infrastructure/repositories/priorizacion.js';
import { conflict, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import type { ArchivoEntrada, ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';

export interface AjusteEntrada {
  cuposTotales?: number;
  valorEstimulo?: number;
  presupuestoTotal?: number;
  distribucionLocalidad?: { itemId: number; cupos: number }[];
  distribucionTransporte?: { itemId: number; cupos: number }[];
  motivo: string;
}

interface CasoOrdenado {
  c: CandidatoFila;
  posicion: number;
  puntajeFinal: number;
  personas: 1 | 2;
  conBeneficio: boolean;
  plan: PlanCaso;
  criterioDesempate: string | null;
}

const vistaFinanzas = (f: Finanzas, dist: ItemDistribucion[]) => ({
  vigencia: { id: f.vigenciaId, anio: f.anio, activa: f.activa },
  cupos: {
    totales: f.cuposTotales,
    ocupados: f.ocupados,
    liberados: f.liberados,
    disponibles: Math.max(0, f.cuposTotales - f.ocupados),
  },
  valorEstimulo: f.valorEstimulo,
  presupuesto: {
    total: f.presupuestoTotal,
    comprometido: f.comprometido,
    disponible: redondearMoneda(f.presupuestoTotal - f.comprometido),
  },
  distribucion: {
    localidades: dist.filter((d) => d.tipo === 'LOCALIDAD'),
    transportes: dist.filter((d) => d.tipo === 'TRANSPORTE'),
  },
});

/**
 * Cupos y presupuesto (RF-ASI-01), asignación en orden de prioridad (RF-ASI-02), lista de espera y reasignación de cupos
 * liberados (RF-ASI-03) y notificación de la asignación (RF-ASI-04). Todo lo que consume cupos o presupuesto ocurre con
 * la fila de la vigencia bloqueada: dos asignadores a la vez no pueden pasarse del cupo ni del saldo.
 */
export class ServicioAsignacion {
  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
    private readonly documentos: ServicioDocumentos,
  ) {}

  private async vigenciaDe(db: Queryable, pedida?: number): Promise<number> {
    const id = pedida ?? (await calculosRepo.vigenciaActivaId(db));
    if (!id) throw conflict('SIN_VIGENCIA', 'No hay una vigencia activa.');
    return id;
  }

  // ---------------------------------------------------------------- cupos y presupuesto (RF-ASI-01)

  async finanzas(vigenciaId?: number) {
    const { pool } = this.deps;
    const id = await this.vigenciaDe(pool, vigenciaId);
    const f = await asignacionRepo.finanzas(pool, id);
    if (!f) throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
    const catalogos = await pool.query<{ id: number; catalogo: string; nombre: string }>(
      `SELECT id, catalogo, nombre FROM catalogo_items
        WHERE catalogo IN ('LOCALIDAD', 'TIPO_TRANSPORTE') AND activo ORDER BY catalogo, nombre`,
    );
    const de = (c: string) =>
      catalogos.rows.filter((x) => x.catalogo === c).map((x) => ({ id: x.id, nombre: x.nombre }));
    return {
      ...vistaFinanzas(f, await asignacionRepo.distribucion(pool, id)),
      // Listas para armar la distribución de cupos.
      catalogos: { localidades: de('LOCALIDAD'), tiposTransporte: de('TIPO_TRANSPORTE') },
    };
  }

  async ajustes(vigenciaId?: number) {
    const { pool } = this.deps;
    const id = await this.vigenciaDe(pool, vigenciaId);
    return (await asignacionRepo.ajustes(pool, id)).map((a) => ({
      id: a.id,
      tipo: a.tipo,
      valorAnterior: a.valorAnterior,
      valorNuevo: a.valorNuevo,
      motivo: a.motivo,
      soporte: a.soporte,
      creadoPor: a.creadoPor,
      creadoAt: a.creadoAt.toISOString(),
    }));
  }

  async soporteDeAjuste(id: number) {
    const e = await asignacionRepo.soporteDeAjuste(this.deps.pool, id);
    if (!e) throw notFound('Ese ajuste no tiene soporte', 'SOPORTE_NO_ENCONTRADO');
    return this.documentos.leerEvidencia(e);
  }

  /**
   * Modifica cupos, valor del estímulo, presupuesto o su distribución. Cada cambio queda registrado con su motivo;
   * subir los cupos o el presupuesto exige el soporte (por ejemplo, el acto de adición presupuestal).
   */
  async ajustar(
    actor: Actor,
    vigenciaId: number | undefined,
    d: AjusteEntrada,
    archivo: ArchivoEntrada | null,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const id = await this.vigenciaDe(pool, vigenciaId);
    const motivo = d.motivo.trim();
    const errores: { campo: string; mensaje: string }[] = [];
    if (motivo.length < 10) {
      errores.push({
        campo: 'motivo',
        mensaje: 'Motivo: explique el cambio (mínimo 10 caracteres)',
      });
    }
    const hayCambio =
      d.cuposTotales !== undefined ||
      d.valorEstimulo !== undefined ||
      d.presupuestoTotal !== undefined ||
      d.distribucionLocalidad !== undefined ||
      d.distribucionTransporte !== undefined;
    if (!hayCambio) errores.push({ campo: 'motivo', mensaje: 'Indique qué desea modificar' });
    if ((d.cuposTotales !== undefined || d.presupuestoTotal !== undefined) && !archivo) {
      errores.push({
        campo: 'archivo',
        mensaje: 'Soporte: adjunte el documento que respalda el cambio de cupos o presupuesto',
      });
    }
    if (errores.length > 0) throw errorValidacion(errores);
    const soporte = archivo ? await this.documentos.guardarEvidencia(`cupos/${id}`, archivo) : null;

    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const fin = await asignacionRepo.finanzas(tx, id, true);
      if (!fin) throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
      const dist = await asignacionRepo.distribucion(tx, id);
      const problemas: { campo: string; mensaje: string }[] = [];
      const cuposNuevos = d.cuposTotales ?? fin.cuposTotales;
      if (d.cuposTotales !== undefined && d.cuposTotales < fin.ocupados) {
        problemas.push({
          campo: 'cuposTotales',
          mensaje: `Cupos: no pueden ser menos que los ${fin.ocupados} que ya están ocupados`,
        });
      }
      if (d.presupuestoTotal !== undefined && d.presupuestoTotal < fin.comprometido) {
        problemas.push({
          campo: 'presupuestoTotal',
          mensaje: 'Presupuesto: no puede ser menor que el ya comprometido',
        });
      }
      const distribuciones: [
        TipoDistribucion,
        string,
        { itemId: number; cupos: number }[] | undefined,
      ][] = [
        ['LOCALIDAD', 'LOCALIDAD', d.distribucionLocalidad],
        ['TRANSPORTE', 'TIPO_TRANSPORTE', d.distribucionTransporte],
      ];
      for (const [tipo, catalogo, items] of distribuciones) {
        if (!items) continue;
        const campo = tipo === 'LOCALIDAD' ? 'distribucionLocalidad' : 'distribucionTransporte';
        const ids = items.map((i) => i.itemId);
        if (new Set(ids).size !== ids.length) {
          problemas.push({ campo, mensaje: 'Distribución: un elemento está repetido' });
        } else if ((await asignacionRepo.itemsDeCatalogo(tx, catalogo, ids)) !== ids.length) {
          problemas.push({ campo, mensaje: 'Distribución: elija elementos de la lista' });
        }
        if (items.reduce((t, i) => t + i.cupos, 0) > cuposNuevos) {
          problemas.push({
            campo,
            mensaje: `Distribución: la suma de los cupos no puede superar los ${cuposNuevos} cupos de la vigencia`,
          });
        }
        for (const i of items) {
          const ocupados =
            dist.find((x) => x.tipo === tipo && x.itemId === i.itemId)?.ocupados ?? 0;
          if (i.cupos < ocupados) {
            problemas.push({
              campo,
              mensaje: `Distribución: un elemento ya tiene ${ocupados} cupos ocupados y no puede quedar con menos`,
            });
          }
        }
      }
      if (
        d.distribucionLocalidad === undefined &&
        d.cuposTotales !== undefined &&
        dist.filter((x) => x.tipo === 'LOCALIDAD').reduce((t, x) => t + x.cupos, 0) > d.cuposTotales
      ) {
        problemas.push({
          campo: 'cuposTotales',
          mensaje:
            'Cupos: la distribución por localidad ya asigna más cupos que esos; ajústela también',
        });
      }
      if (
        d.distribucionTransporte === undefined &&
        d.cuposTotales !== undefined &&
        dist.filter((x) => x.tipo === 'TRANSPORTE').reduce((t, x) => t + x.cupos, 0) >
          d.cuposTotales
      ) {
        problemas.push({
          campo: 'cuposTotales',
          mensaje:
            'Cupos: la distribución por tipo de transporte ya asigna más cupos que esos; ajústela también',
        });
      }
      if (problemas.length > 0) throw errorValidacion(problemas);

      const cambios: { tipo: TipoAjuste; anterior: unknown; nuevo: unknown }[] = [];
      if (d.cuposTotales !== undefined && d.cuposTotales !== fin.cuposTotales) {
        cambios.push({ tipo: 'CUPOS', anterior: fin.cuposTotales, nuevo: d.cuposTotales });
      }
      if (d.valorEstimulo !== undefined && d.valorEstimulo !== fin.valorEstimulo) {
        cambios.push({
          tipo: 'VALOR_ESTIMULO',
          anterior: fin.valorEstimulo,
          nuevo: d.valorEstimulo,
        });
      }
      if (d.presupuestoTotal !== undefined && d.presupuestoTotal !== fin.presupuestoTotal) {
        cambios.push({
          tipo: 'PRESUPUESTO',
          anterior: fin.presupuestoTotal,
          nuevo: d.presupuestoTotal,
        });
      }
      const sinCambio = (items: { itemId: number; cupos: number }[], tipo: TipoDistribucion) => {
        const actuales = dist.filter((x) => x.tipo === tipo);
        return (
          actuales.length === items.length &&
          items.every((i) => actuales.some((a) => a.itemId === i.itemId && a.cupos === i.cupos))
        );
      };
      for (const [tipo, , items] of distribuciones) {
        if (!items || sinCambio(items, tipo)) continue;
        cambios.push({
          tipo: tipo === 'LOCALIDAD' ? 'DISTRIBUCION_LOCALIDAD' : 'DISTRIBUCION_TRANSPORTE',
          anterior: dist
            .filter((x) => x.tipo === tipo)
            .map((x) => ({ itemId: x.itemId, nombre: x.nombre, cupos: x.cupos })),
          nuevo: items,
        });
      }
      if (cambios.length === 0) {
        throw errorValidacion([
          { campo: 'motivo', mensaje: 'No hay ningún cambio respecto a lo vigente' },
        ]);
      }
      if (cambios.some((c) => (c.tipo === 'CUPOS' || c.tipo === 'PRESUPUESTO') && !soporte)) {
        throw errorValidacion([
          { campo: 'archivo', mensaje: 'Soporte: adjunte el documento del cambio' },
        ]);
      }
      await asignacionRepo.actualizarVigencia(tx, id, {
        cuposTotales: d.cuposTotales,
        valorEstimulo: d.valorEstimulo,
        presupuestoTotal: d.presupuestoTotal,
      });
      for (const [tipo, , items] of distribuciones) {
        if (items && cambios.some((c) => c.tipo === `DISTRIBUCION_${tipo}`)) {
          await asignacionRepo.reemplazarDistribucion(tx, id, tipo, items);
        }
      }
      for (const c of cambios) {
        await asignacionRepo.insertarAjuste(tx, {
          vigenciaId: id,
          tipo: c.tipo,
          anterior: c.anterior,
          nuevo: c.nuevo,
          motivo,
          soporte,
          usuarioId: actor.id,
        });
        await bitacoraRepo.registrar(tx, {
          usuarioId: actor.id,
          modulo: MODULO.ASIGNACION,
          accion: ACCION.CUPOS_AJUSTADOS,
          entidad: 'vigencia',
          entidadId: id,
          valorAnterior: { [c.tipo]: c.anterior },
          valorNuevo: { [c.tipo]: c.nuevo },
          justificacion: motivo,
          detalle: soporte ? { soporte: soporte.nombre, sha256: soporte.sha256 } : {},
          ip: ctx.ip,
        });
      }
    });
    return this.finanzas(id);
  }

  // ---------------------------------------------------------------- propuesta de asignación (RF-ASI-02)

  /** Casos asignables en orden de prioridad, con lo que alcanza según los cupos, el presupuesto y la distribución. */
  private async ordenar(
    db: Queryable,
    vigenciaId: number,
    fin: Finanzas,
  ): Promise<{
    casos: CasoOrdenado[];
    dist: ItemDistribucion[];
    desempate: string[];
    variables: { codigo: string; nombre: string }[];
  }> {
    const [candidatos, matriz, dist] = await Promise.all([
      asignacionRepo.candidatos(db, vigenciaId),
      matricesRepo.vigente(db),
      asignacionRepo.distribucion(db, vigenciaId),
    ]);
    const personas = candidatos.flatMap((c) =>
      c.cuidadorId ? [c.pcdId, c.cuidadorId] : [c.pcdId],
    );
    const conBeneficio = await asignacionRepo.personasConBeneficio(db, personas);
    const ordenados = ordenarPorPrioridad(
      candidatos.map((c) => ({ ...c, puntajeFinal: redondear(c.puntaje + c.ajuste) })),
      matriz?.desempate ?? [],
    );
    const entradas: CandidatoAsignacion[] = ordenados.map((o) => ({
      solicitudId: o.solicitudId,
      personas: o.cuidadorId ? 2 : 1,
      localidadId: o.localidadId,
      transporteId: o.transporteId,
      conBeneficio:
        conBeneficio.has(o.pcdId) || (o.cuidadorId !== null && conBeneficio.has(o.cuidadorId)),
    }));
    const restantes = (tipo: TipoDistribucion) =>
      new Map(
        dist
          .filter((x) => x.tipo === tipo)
          .map((x) => [x.itemId, Math.max(0, x.cupos - x.ocupados)] as const),
      );
    const plan = planificarAsignacion(entradas, {
      cuposDisponibles: Math.max(0, fin.cuposTotales - fin.ocupados),
      presupuestoDisponible: fin.presupuestoTotal - fin.comprometido,
      valorEstimulo: fin.valorEstimulo,
      cuposLocalidad: restantes('LOCALIDAD'),
      cuposTransporte: restantes('TRANSPORTE'),
    });
    return {
      casos: ordenados.map((o, i) => ({
        c: o,
        posicion: i + 1,
        puntajeFinal: o.puntajeFinal,
        personas: (entradas[i] as CandidatoAsignacion).personas,
        conBeneficio: (entradas[i] as CandidatoAsignacion).conBeneficio,
        plan: plan[i] as PlanCaso,
        criterioDesempate: o.criterioDesempate,
      })),
      dist,
      desempate: matriz?.desempate ?? [],
      variables: matriz?.variables ?? [],
    };
  }

  async propuesta(f: { vigenciaId?: number; limit: number; offset: number }) {
    const { pool } = this.deps;
    const id = await this.vigenciaDe(pool, f.vigenciaId);
    const fin = await asignacionRepo.finanzas(pool, id);
    if (!fin) throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
    const { casos, dist, variables } = await this.ordenar(pool, id, fin);
    return {
      resumen: vistaFinanzas(fin, dist),
      total: casos.length,
      alcanzan: casos.filter((x) => x.plan.alcanza).length,
      sinCupo: casos.filter((x) => !x.plan.alcanza && x.plan.motivo !== 'PERSONA_CON_BENEFICIO')
        .length,
      items: casos.slice(f.offset, f.offset + f.limit).map((x) => ({
        posicion: x.posicion,
        solicitudId: x.c.solicitudId,
        radicado: x.c.radicado,
        radicadaAt: x.c.radicadaAt.toISOString(),
        pcdNombre: x.c.pcdNombre,
        estado: x.c.estado,
        localidad: x.c.localidad,
        transporte: x.c.transporte,
        conCuidador: x.c.conCuidador,
        puntaje: x.c.puntaje,
        ajuste: x.c.ajuste,
        puntajeFinal: x.puntajeFinal,
        criterioDesempate: describirCriterio(x.criterioDesempate, variables),
        alcanza: x.plan.alcanza,
        motivo: x.plan.motivo,
        motivoTexto: x.plan.motivo ? TEXTO_MOTIVO[x.plan.motivo] : null,
      })),
    };
  }

  /**
   * Asigna el beneficio a los casos elegidos (de forma individual o por lotes). Cada uno debe caber en los cupos y el
   * presupuesto, y si el asignador se salta casos que le correspondían por orden debe dejar la causa de cada uno.
   */
  async asignar(
    actor: Actor,
    d: {
      vigenciaId?: number;
      solicitudIds: number[];
      omisiones: { solicitudId: number; causa: string }[];
    },
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const vigenciaId = await this.vigenciaDe(pool, d.vigenciaId);
    const asignados = await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const fin = await asignacionRepo.finanzas(tx, vigenciaId, true);
      if (!fin) throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
      const { casos } = await this.ordenar(tx, vigenciaId, fin);
      const elegidos = new Set(d.solicitudIds);
      const desconocidos = d.solicitudIds.filter(
        (id) => !casos.some((x) => x.c.solicitudId === id),
      );
      if (desconocidos.length > 0) {
        throw conflict(
          'CASO_NO_ASIGNABLE',
          'Alguno de los casos ya no está disponible para asignar (se asignó o cambió de estado). Actualice la propuesta.',
        );
      }
      // Lo elegido, en orden de prioridad, debe caber (los topes se consumen en ese orden).
      const seleccion = casos.filter((x) => elegidos.has(x.c.solicitudId));
      const plan = planificarAsignacion(
        seleccion.map((x) => ({
          solicitudId: x.c.solicitudId,
          personas: x.personas,
          localidadId: x.c.localidadId,
          transporteId: x.c.transporteId,
          conBeneficio: x.conBeneficio,
        })),
        {
          cuposDisponibles: Math.max(0, fin.cuposTotales - fin.ocupados),
          presupuestoDisponible: fin.presupuestoTotal - fin.comprometido,
          valorEstimulo: fin.valorEstimulo,
          cuposLocalidad: this.restantes(
            await asignacionRepo.distribucion(tx, vigenciaId),
            'LOCALIDAD',
          ),
          cuposTransporte: this.restantes(
            await asignacionRepo.distribucion(tx, vigenciaId),
            'TRANSPORTE',
          ),
        },
      );
      const noCaben = plan.filter((p) => !p.alcanza);
      if (noCaben.length > 0) {
        const primero = noCaben[0] as PlanCaso;
        const radicado = casos.find((x) => x.c.solicitudId === primero.solicitudId)?.c.radicado;
        throw conflict(
          primero.motivo === 'PERSONA_CON_BENEFICIO' ? 'PERSONA_CON_BENEFICIO' : 'SIN_CUPO',
          `${radicado}: ${TEXTO_MOTIVO[primero.motivo as keyof typeof TEXTO_MOTIVO]}.`,
          { casos: noCaben.map((p) => ({ solicitudId: p.solicitudId, motivo: p.motivo })) },
        );
      }
      // Casos que se saltan: cada uno necesita su causa.
      const saltados = casosSaltados(
        casos.map((x) => ({ solicitudId: x.c.solicitudId, asignable: x.plan.alcanza })),
        elegidos,
      );
      const causas = new Map(d.omisiones.map((o) => [o.solicitudId, o.causa.trim()]));
      const sinCausa = saltados.filter((id) => (causas.get(id) ?? '').length < 10);
      if (sinCausa.length > 0) {
        throw errorValidacion([
          {
            campo: 'omisiones',
            mensaje: `Causa de no asignación: explique por qué no se asigna ${casos
              .filter((x) => sinCausa.includes(x.c.solicitudId))
              .map((x) => x.c.radicado)
              .join(', ')} que va antes en el orden de prioridad (mínimo 10 caracteres)`,
          },
        ]);
      }
      for (const id of saltados) {
        const x = casos.find((y) => y.c.solicitudId === id) as CasoOrdenado;
        await asignacionRepo.insertarOmision(tx, {
          solicitudId: id,
          posicion: x.posicion,
          puntajeFinal: x.puntajeFinal,
          causa: causas.get(id) as string,
          usuarioId: actor.id,
        });
        await bitacoraRepo.registrar(tx, {
          usuarioId: actor.id,
          modulo: MODULO.ASIGNACION,
          accion: ACCION.ASIGNACION_OMITIDA,
          entidad: 'solicitud',
          entidadId: id,
          solicitudId: id,
          justificacion: causas.get(id),
          detalle: { posicion: x.posicion, puntajeFinal: x.puntajeFinal },
          ip: ctx.ip,
        });
      }

      const [lugar, documentos, instrucciones] = await Promise.all([
        parametrosRepo.texto(tx, 'entrega_lugar'),
        parametrosRepo.texto(tx, 'entrega_documentos'),
        parametrosRepo.texto(tx, 'entrega_instrucciones'),
      ]);
      const resultado: { solicitudId: number; radicado: string; beneficioId: number }[] = [];
      for (const x of seleccion) {
        const reemplazaId = await asignacionRepo.cupoLiberadoSinReasignar(tx, vigenciaId);
        let beneficioId: number;
        try {
          beneficioId = await asignacionRepo.crearBeneficio(tx, {
            solicitudId: x.c.solicitudId,
            vigenciaId,
            personas: x.personas,
            valorComprometido: redondearMoneda(fin.valorEstimulo * x.personas),
            localidadId: x.c.localidadId,
            transporteId: x.c.transporteId,
            priorizacionId: x.c.priorizacionId,
            puntajeFinal: x.puntajeFinal,
            posicion: x.posicion,
            usuarioId: actor.id,
            reemplazaId,
            pcdId: x.c.pcdId,
            cuidadorId: x.c.cuidadorId,
          });
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw conflict(
              'PERSONA_CON_BENEFICIO',
              `${x.c.radicado}: alguna de las personas ya tiene un beneficio vigente (RN-01).`,
            );
          }
          throw error;
        }
        await tx.query(
          `UPDATE solicitudes SET estado = 'ASIGNADA', updated_at = now() WHERE id = $1`,
          [x.c.solicitudId],
        );
        await this.correos.encolar(tx, {
          solicitudId: x.c.solicitudId,
          tipo: 'ASIGNACION_BENEFICIO',
          destinatario: x.c.correo,
          datos: {
            nombre: x.c.pcdNombre,
            radicado: x.c.radicado,
            lugarEntrega: lugar,
            documentosEntrega: documentos,
            instruccionesEntrega: instrucciones,
            enlaceConsulta: await this.correos.enlaceConsulta(tx, x.c.solicitudId),
          },
        });
        await bitacoraRepo.registrar(tx, {
          usuarioId: actor.id,
          modulo: MODULO.ASIGNACION,
          accion: ACCION.BENEFICIO_ASIGNADO,
          entidad: 'beneficio',
          entidadId: beneficioId,
          solicitudId: x.c.solicitudId,
          valorAnterior: { estado: x.c.estado },
          valorNuevo: { estado: 'ASIGNADA', beneficio: 'PENDIENTE_ENTREGA' },
          detalle: {
            posicion: x.posicion,
            puntajeFinal: x.puntajeFinal,
            personas: x.personas,
            valorComprometido: fin.valorEstimulo * x.personas,
            reemplazaBeneficio: reemplazaId,
          },
          ip: ctx.ip,
        });
        resultado.push({ solicitudId: x.c.solicitudId, radicado: x.c.radicado, beneficioId });
      }
      return resultado;
    });
    this.correos.despachar();
    return {
      asignados: asignados.length,
      items: asignados,
      resumen: await this.finanzas(vigenciaId),
    };
  }

  private restantes(dist: ItemDistribucion[], tipo: TipoDistribucion): Map<number, number> {
    return new Map(
      dist
        .filter((x) => x.tipo === tipo)
        .map((x) => [x.itemId, Math.max(0, x.cupos - x.ocupados)] as const),
    );
  }

  // ---------------------------------------------------------------- lista de espera (RF-ASI-03, RF-ASI-04)

  /**
   * Pasa a «En lista de espera» los casos priorizados que no alcanzan cupo o presupuesto (o solo los indicados) y avisa
   * a cada persona. Conservan su lugar según el puntaje.
   */
  async enviarAListaEspera(
    actor: Actor,
    d: { vigenciaId?: number; solicitudIds?: number[] },
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const vigenciaId = await this.vigenciaDe(pool, d.vigenciaId);
    const movidos = await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const fin = await asignacionRepo.finanzas(tx, vigenciaId, true);
      if (!fin) throw notFound('La vigencia no existe', 'VIGENCIA_NO_ENCONTRADA');
      const { casos } = await this.ordenar(tx, vigenciaId, fin);
      const pedidos = d.solicitudIds ? new Set(d.solicitudIds) : null;
      if (pedidos) {
        const alcanza = casos.filter((x) => pedidos.has(x.c.solicitudId) && x.plan.alcanza);
        if (alcanza.length > 0) {
          throw conflict(
            'CASO_CON_CUPO',
            `${alcanza.map((x) => x.c.radicado).join(', ')}: todavía alcanza cupo; asígnelo en lugar de dejarlo en espera.`,
          );
        }
      }
      const objetivo = casos.filter(
        (x) =>
          x.c.estado === 'PRIORIZADA' &&
          !x.plan.alcanza &&
          x.plan.motivo !== 'PERSONA_CON_BENEFICIO' &&
          (!pedidos || pedidos.has(x.c.solicitudId)),
      );
      const movidos: string[] = [];
      for (const x of objetivo) {
        await tx.query(
          `UPDATE solicitudes SET estado = 'EN_LISTA_ESPERA', updated_at = now() WHERE id = $1 AND estado = 'PRIORIZADA'`,
          [x.c.solicitudId],
        );
        await this.correos.encolar(tx, {
          solicitudId: x.c.solicitudId,
          tipo: 'LISTA_ESPERA',
          destinatario: x.c.correo,
          datos: {
            nombre: x.c.pcdNombre,
            radicado: x.c.radicado,
            enlaceConsulta: await this.correos.enlaceConsulta(tx, x.c.solicitudId),
          },
        });
        await bitacoraRepo.registrar(tx, {
          usuarioId: actor.id,
          modulo: MODULO.ASIGNACION,
          accion: ACCION.CASO_EN_LISTA_ESPERA,
          entidad: 'solicitud',
          entidadId: x.c.solicitudId,
          solicitudId: x.c.solicitudId,
          valorAnterior: { estado: 'PRIORIZADA' },
          valorNuevo: { estado: 'EN_LISTA_ESPERA' },
          detalle: { posicion: x.posicion, puntajeFinal: x.puntajeFinal, motivo: x.plan.motivo },
          ip: ctx.ip,
        });
        movidos.push(x.c.radicado);
      }
      return movidos;
    });
    this.correos.despachar();
    return { enListaDeEspera: movidos.length, radicados: movidos };
  }

  // ---------------------------------------------------------------- beneficiarios

  async beneficiarios(f: {
    vigenciaId?: number;
    estado?: EstadoBeneficio;
    q?: string;
    limit: number;
    offset: number;
  }) {
    const { pool } = this.deps;
    const vigenciaId = await this.vigenciaDe(pool, f.vigenciaId);
    const r = await asignacionRepo.beneficiarios(pool, { ...f, vigenciaId });
    return {
      total: r.total,
      items: r.items.map((b) => ({
        ...b,
        asignadoAt: b.asignadoAt.toISOString(),
        finalizadoAt: b.finalizadoAt?.toISOString() ?? null,
      })),
    };
  }

  // ---------------------------------------------------------------- cupo liberado (RF-ASI-03)

  /**
   * Finaliza un beneficio: libera su cupo y su presupuesto, y le avisa al asignador cuál es el siguiente caso de la
   * lista que podría ocuparlo. Lo usan la revocatoria, la renuncia y el fallecimiento (RF-NOV-02).
   */
  async liberarCupo(
    tx: Queryable,
    actorId: number | null,
    beneficioId: number,
    motivo: string,
    ctx: ContextoPeticion,
  ): Promise<void> {
    const b = await asignacionRepo.beneficio(tx, beneficioId);
    if (!b) throw notFound('El beneficio no existe', 'BENEFICIO_NO_ENCONTRADO');
    if (b.estado === 'FINALIZADO')
      throw conflict('BENEFICIO_FINALIZADO', 'El beneficio ya está finalizado.');
    await asignacionRepo.finalizar(tx, beneficioId, motivo);
    await bitacoraRepo.registrar(tx, {
      usuarioId: actorId,
      modulo: MODULO.ASIGNACION,
      accion: ACCION.CUPO_LIBERADO,
      entidad: 'beneficio',
      entidadId: beneficioId,
      solicitudId: b.solicitudId,
      valorAnterior: { estado: b.estado },
      valorNuevo: { estado: 'FINALIZADO' },
      justificacion: motivo,
      ip: ctx.ip,
    });
    const fin = await asignacionRepo.finanzas(tx, b.vigenciaId);
    const siguiente = fin
      ? (await this.ordenar(tx, b.vigenciaId, fin)).casos.find((x) => x.plan.alcanza)
      : undefined;
    await alertasRepo.crear(tx, {
      tipo: 'CUPO_LIBERADO',
      permisoDestino: 'asignacion.asignar',
      titulo: `Se liberó un cupo (${b.radicado})`,
      mensaje: siguiente
        ? `El siguiente caso en el orden de prioridad es ${siguiente.c.radicado} (${siguiente.puntajeFinal} puntos). Revise la propuesta de asignación.`
        : 'No hay casos pendientes por asignar que puedan ocupar el cupo.',
      enlace: '/interno/asignacion',
      solicitudId: b.solicitudId,
      beneficioId,
      clave: `CUPO_LIBERADO:${beneficioId}`,
    });
  }

  // ---------------------------------------------------------------- avisos internos

  async alertas(actor: Actor) {
    const lista = await alertasRepo.pendientes(this.deps.pool, [...actor.permisos]);
    return lista.map((a) => ({ ...a, creadaAt: a.creadaAt.toISOString() }));
  }

  async atenderAlerta(actor: Actor, id: number, ctx: ContextoPeticion) {
    const ok = await alertasRepo.atender(this.deps.pool, id, [...actor.permisos], actor.id);
    if (!ok) throw notFound('El aviso no existe o ya se atendió', 'ALERTA_NO_ENCONTRADA');
    await bitacoraRepo.registrar(this.deps.pool, {
      usuarioId: actor.id,
      modulo: MODULO.ASIGNACION,
      accion: ACCION.ALERTA_ATENDIDA,
      entidad: 'alerta',
      entidadId: id,
      ip: ctx.ip,
    });
  }
}
