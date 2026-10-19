import { createHash, randomBytes } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import {
  CAMPOS_SENSIBLES,
  datosVacios,
  type DatosCaracterizacion,
} from '../domain/caracterizacion.js';
import { AVISO_PREINSCRIPCION } from '../domain/correos.js';
import { ESTADOS, type EstadoSolicitud } from '../domain/estados.js';
import {
  RESULTADOS,
  erroresDeDecision,
  esSubsanable,
  textoItemsSubsanar,
  type DecisionValidacion,
  type ItemChequeo,
} from '../domain/validacion.js';
import { fijarActor } from '../infrastructure/db/actor.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { caracterizacionRepo } from '../infrastructure/repositories/caracterizacion.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import { requisitosRepo } from '../infrastructure/repositories/requisitos.js';
import { tokensRepo } from '../infrastructure/repositories/solicitudes.js';
import {
  validacionRepo,
  type FiltroBandeja,
  type ItemFila,
  type ItemSubsanacion,
} from '../infrastructure/repositories/validacion.js';
import { DataCipher } from '../infrastructure/security/crypto.js';
import { conflict, forbidden, notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioCorreos } from './correos.js';
import type { ServicioDocumentos } from './documentos.js';
import { errorValidacion } from './esquemas.js';

/** Estados en los que un funcionario puede tomar el caso para revisarlo. */
const REVISABLES: readonly EstadoSolicitud[] = [
  'RADICADA',
  'SUBSANADA',
  'EN_REVISION',
  'EN_SUBSANACION',
];

const FECHA_LARGA = new Intl.DateTimeFormat('es-CO', {
  timeZone: 'America/Bogota',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

export interface DatosItemEntrada {
  resultado: (typeof RESULTADOS)[number];
  fuente: string;
  observacion: string;
  evidencia: string;
}

/**
 * Validación de requisitos (RF-VAL-01, RF-VAL-02, RF-VAL-05): bandeja de trabajo, revisión requisito por requisito
 * con la lista de chequeo, decisión motivada y notificación del resultado. Un caso solo lo trabaja una persona a la
 * vez, y cada acción queda en la bitácora.
 */
export class ServicioValidacion {
  private readonly cipher: DataCipher;

  constructor(
    private readonly deps: Dependencias,
    private readonly correos: ServicioCorreos,
    private readonly documentos: ServicioDocumentos,
  ) {
    this.cipher = new DataCipher(deps.env.encryption);
  }

  // ---------------------------------------------------------------- bandeja

  async bandeja(f: Omit<FiltroBandeja, 'tiempoMaxDias'>) {
    const tiempoMaxDias = await parametrosRepo.entero(this.deps.pool, 'tiempo_max_atencion_dias');
    const r = await validacionRepo.bandeja(this.deps.pool, { ...f, tiempoMaxDias });
    return {
      total: r.total,
      tiempoMaxDias,
      items: r.items.map((x) => ({
        solicitudId: x.solicitudId,
        radicado: x.radicado,
        radicadaAt: x.radicadaAt.toISOString(),
        estado: { codigo: x.estado, nombre: ESTADOS[x.estado].nombre },
        pcdNombre: x.pcdNombre,
        dias: x.dias,
        // Resalta los casos que superan el tiempo máximo de atención (RF-VAL-01).
        superaTiempo: x.dias > tiempoMaxDias,
        asignadoA: x.asignadoA,
        enRevisionPor: x.enRevisionPor,
        subsanado: x.subsanado,
        ronda: x.ronda,
        subsanacionVenceAt: x.subsanacionVenceAt?.toISOString() ?? null,
        subsanacionVencida: x.subsanacionVencida,
      })),
    };
  }

  /** Validadores a quienes se puede asignar un caso. */
  validadores() {
    return validacionRepo.usuariosConPermiso(this.deps.pool, 'validacion.validar');
  }

  /** El responsable del proceso asigna o reasigna casos entre validadores (RF-VAL-01). */
  async asignar(
    actor: Actor,
    solicitudIds: number[],
    validadorId: number | null,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    if (
      validadorId !== null &&
      !(await validacionRepo.tienePermiso(pool, validadorId, 'validacion.validar'))
    ) {
      throw errorValidacion([
        { campo: 'validadorId', mensaje: 'Validador: elija a una persona que pueda validar casos' },
      ]);
    }
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      for (const id of solicitudIds) {
        const base = await validacionRepo.casoBase(tx, id);
        if (!base || !REVISABLES.includes(base.estado)) {
          throw conflict(
            'CASO_NO_ASIGNABLE',
            'Solo se pueden asignar casos pendientes de validación.',
            { solicitudId: id },
          );
        }
        const antes = await validacionRepo.asegurarYBloquear(tx, id);
        await validacionRepo.asignar(tx, id, validadorId, actor.id);
        if (base.estado === 'EN_REVISION') {
          // Quien lo tenía en revisión lo pierde: vuelve a la bandeja.
          await validacionRepo.fijarEstado(tx, id, antes.subsanado ? 'SUBSANADA' : 'RADICADA');
        }
        await bitacoraRepo.registrar(tx, {
          usuarioId: actor.id,
          modulo: MODULO.VALIDACION,
          accion: ACCION.VALIDACION_ASIGNADA,
          entidad: 'solicitud',
          entidadId: id,
          solicitudId: id,
          valorAnterior: { asignadoA: antes.asignadoA },
          valorNuevo: { asignadoA: validadorId },
          ip: ctx.ip,
        });
      }
    });
    return { asignados: solicitudIds.length };
  }

  // ---------------------------------------------------------------- tomar / liberar

  /**
   * Al abrir un caso queda «en revisión» por quien lo abre: nadie más lo puede trabajar al mismo tiempo (RF-VAL-01).
   * Un caso con subsanación vigente espera a la persona; solo se toma cuando venció el plazo.
   */
  async tomar(actor: Actor, solicitudId: number, ctx: ContextoPeticion) {
    const { pool } = this.deps;
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const base = await validacionRepo.casoBase(tx, solicitudId);
      if (!base) throw notFound('El caso no existe', 'CASO_NO_ENCONTRADO');
      if (!REVISABLES.includes(base.estado)) {
        throw conflict('CASO_NO_REVISABLE', 'Este caso no está pendiente de validación.');
      }
      const v = await validacionRepo.asegurarYBloquear(tx, solicitudId);
      if (base.estado === 'EN_SUBSANACION') {
        const sub = await validacionRepo.ultimaSubsanacion(tx, solicitudId, true);
        if (!sub?.vencida) {
          throw conflict(
            'ESPERANDO_RESPUESTA',
            'Se pidió subsanación y todavía corre el plazo de la persona.',
          );
        }
      }
      if (v.tomadaPor !== null && v.tomadaPor !== actor.id) {
        throw conflict(
          'CASO_EN_REVISION',
          `El caso lo está revisando ${v.tomadaNombre ?? 'otra persona'}.`,
          { enRevisionPor: v.tomadaNombre },
        );
      }
      if (
        v.asignadoA !== null &&
        v.asignadoA !== actor.id &&
        !actor.permisos.has('validacion.asignar')
      ) {
        throw conflict(
          'CASO_ASIGNADO',
          `El caso está asignado a ${v.asignadoNombre ?? 'otro validador'}.`,
          { asignadoA: v.asignadoNombre },
        );
      }
      const caract = await caracterizacionRepo.obtener(tx, solicitudId, this.cipher);
      const requiereCuidador = caract?.datos.requiereCuidador === true;
      await validacionRepo.asegurarItems(
        tx,
        solicitudId,
        await requisitosRepo.aplicables(tx, requiereCuidador),
      );
      if (v.tomadaPor !== actor.id) {
        await validacionRepo.tomar(tx, solicitudId, actor.id);
        await bitacoraRepo.registrar(tx, {
          usuarioId: actor.id,
          modulo: MODULO.VALIDACION,
          accion: ACCION.VALIDACION_TOMADA,
          entidad: 'solicitud',
          entidadId: solicitudId,
          solicitudId,
          valorAnterior: { estado: base.estado },
          valorNuevo: { estado: base.estado === 'EN_SUBSANACION' ? base.estado : 'EN_REVISION' },
          ip: ctx.ip,
        });
      }
      if (base.estado === 'RADICADA' || base.estado === 'SUBSANADA') {
        await validacionRepo.fijarEstado(tx, solicitudId, 'EN_REVISION');
      }
    });
  }

  /** Devuelve el caso a la bandeja sin decidir. */
  async liberar(actor: Actor, solicitudId: number, ctx: ContextoPeticion) {
    await withTransaction(this.deps.pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const base = await validacionRepo.casoBase(tx, solicitudId);
      if (!base) throw notFound('El caso no existe', 'CASO_NO_ENCONTRADO');
      const v = await validacionRepo.asegurarYBloquear(tx, solicitudId);
      if (v.tomadaPor === null) return;
      if (v.tomadaPor !== actor.id && !actor.permisos.has('validacion.asignar')) {
        throw forbidden('Solo quien lo está revisando puede devolver el caso a la bandeja.');
      }
      await validacionRepo.liberar(tx, solicitudId);
      if (base.estado === 'EN_REVISION') {
        await validacionRepo.fijarEstado(tx, solicitudId, v.subsanado ? 'SUBSANADA' : 'RADICADA');
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.VALIDACION,
        accion: ACCION.VALIDACION_LIBERADA,
        entidad: 'solicitud',
        entidadId: solicitudId,
        solicitudId,
        ip: ctx.ip,
      });
    });
  }

  // ---------------------------------------------------------------- caso

  private ocultarSensibles(datos: DatosCaracterizacion): DatosCaracterizacion {
    const copia = { ...datos } as unknown as Record<string, unknown>;
    for (const c of CAMPOS_SENSIBLES) copia[c] = null;
    return copia as unknown as DatosCaracterizacion;
  }

  /** Todo lo que el funcionario necesita para revisar el caso. Los datos sensibles solo los ven los roles autorizados. */
  async caso(actor: Actor, solicitudId: number) {
    const { pool } = this.deps;
    const base = await validacionRepo.casoBase(pool, solicitudId);
    if (!base || !base.radicado) throw notFound('El caso no existe', 'CASO_NO_ENCONTRADO');
    const verSensibles = actor.permisos.has('datos.sensibles.ver');
    const [v, items, decisiones, sub, caract, docs, tiempoMax, maxRondas, previas] =
      await Promise.all([
        validacionRepo.validacion(pool, solicitudId),
        validacionRepo.items(pool, solicitudId),
        validacionRepo.decisiones(pool, solicitudId),
        validacionRepo.ultimaSubsanacion(pool, solicitudId),
        caracterizacionRepo.obtener(pool, solicitudId, this.cipher),
        this.documentos.listar(solicitudId),
        parametrosRepo.entero(pool, 'tiempo_max_atencion_dias'),
        parametrosRepo.entero(pool, 'max_rondas_subsanacion'),
        validacionRepo.contarSubsanaciones(pool, solicitudId),
      ]);
    const datosCompletos = caract?.datos ?? datosVacios();
    const datos = verSensibles ? datosCompletos : this.ocultarSensibles(datosCompletos);
    const ids = (Object.values(datos) as unknown[]).filter(
      (x): x is number => typeof x === 'number',
    );
    const catalogos = Object.fromEntries(
      (await caracterizacionRepo.itemsPorId(pool, ids)).map((i) => [i.id, i.nombre]),
    );
    const edita =
      v?.tomadaPor === actor.id &&
      actor.permisos.has('validacion.validar') &&
      (base.estado === 'EN_REVISION' ||
        (base.estado === 'EN_SUBSANACION' && sub?.vencida === true));
    const d = ESTADOS[base.estado];
    const dias = Math.floor((Date.now() - (base.radicadaAt?.getTime() ?? Date.now())) / 86_400_000);
    return {
      solicitud: {
        id: base.solicitudId,
        radicado: base.radicado,
        radicadaAt: base.radicadaAt?.toISOString() ?? null,
        vigencia: base.anio,
        estado: { codigo: base.estado, nombre: d.nombre },
        dias,
        superaTiempo: dias > tiempoMax,
        correo: base.correo,
        direccion: base.direccion,
        localidad: base.localidad,
        barrio: base.barrio,
      },
      pcd: base.pcd,
      cuidador: base.cuidador,
      validacion: {
        asignadoA: v?.asignadoNombre ?? null,
        enRevisionPor: v?.tomadaNombre ?? null,
        tomadaAt: v?.tomadaAt?.toISOString() ?? null,
        ronda: v?.ronda ?? 1,
        subsanado: v?.subsanado ?? false,
        puedeEditar: edita,
        subsanacionesPrevias: previas,
        maxRondas,
      },
      datos,
      catalogos,
      sensiblesOcultos: !verSensibles,
      version: caract?.version ?? 0,
      documentos: docs.documentos.map((x) => ({
        id: x.id,
        nombre: x.nombre,
        aplicaA: x.aplicaA,
        obligatorio: x.obligatorio,
        estado: x.estado,
        reemplazos: x.reemplazos,
        archivo: x.archivo,
        puedeVer: verSensibles && x.archivo !== null,
      })),
      items: items.map((i) => this.itemVista(i)),
      decisiones: decisiones.map((x) => ({
        id: x.id,
        ronda: x.ronda,
        decision: x.decision,
        motivacion: x.motivacion,
        decididoPor: x.decididoPor,
        decididoAt: x.decididoAt.toISOString(),
        items: x.items,
      })),
      subsanacion: sub
        ? {
            estado: sub.estado,
            venceAt: sub.venceAt.toISOString(),
            vencida: sub.vencida,
            respondidaAt: sub.respondidaAt?.toISOString() ?? null,
            items: sub.items,
          }
        : null,
    };
  }

  private itemVista(i: ItemFila) {
    return {
      id: i.id,
      requisitoId: i.requisitoId,
      codigo: i.codigo,
      nombre: i.nombre,
      descripcion: i.descripcion,
      aplicaA: i.aplicaA,
      fuenteSugerida: i.fuenteSugerida,
      documentoId: i.documentoId,
      campos: i.campos,
      cruceCodigo: i.cruceCodigo,
      resultado: i.resultado,
      fuente: i.fuente,
      observacion: i.observacion,
      evidencia: i.evidencia,
      registradoPor: i.registradoPor,
      registradoAt: i.registradoAt?.toISOString() ?? null,
      version: i.version,
      subsanable: esSubsanable(i),
    };
  }

  // ---------------------------------------------------------------- lista de chequeo

  async registrarItem(
    actor: Actor,
    solicitudId: number,
    itemId: number,
    d: DatosItemEntrada,
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      await this.exigirRevision(tx, actor, solicitudId);
      const actual = await validacionRepo.item(tx, solicitudId, itemId);
      if (!actual)
        throw notFound(
          'Ese requisito no está en la lista de chequeo del caso',
          'ITEM_NO_ENCONTRADO',
        );
      await validacionRepo.actualizarItem(tx, itemId, d, actor.id);
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.VALIDACION,
        accion: ACCION.VALIDACION_ITEM_REGISTRADO,
        entidad: 'requisito',
        entidadId: itemId,
        solicitudId,
        valorAnterior: {
          resultado: actual.resultado,
          fuente: actual.fuente,
          observacion: actual.observacion,
        },
        valorNuevo: { resultado: d.resultado, fuente: d.fuente, observacion: d.observacion },
        detalle: { requisito: actual.codigo },
        ip: ctx.ip,
      });
    });
    return this.itemVista((await validacionRepo.item(pool, solicitudId, itemId)) as ItemFila);
  }

  /** Quien registra o decide debe tener el caso en revisión. */
  private async exigirRevision(
    db: Parameters<typeof validacionRepo.validacion>[0],
    actor: Actor,
    solicitudId: number,
  ) {
    if (!actor.permisos.has('validacion.validar')) throw forbidden();
    const base = await validacionRepo.casoBase(db, solicitudId);
    if (!base) throw notFound('El caso no existe', 'CASO_NO_ENCONTRADO');
    const v = await validacionRepo.asegurarYBloquear(db, solicitudId);
    if (v.tomadaPor !== actor.id) {
      throw conflict(
        'CASO_NO_TOMADO',
        v.tomadaPor
          ? `El caso lo está revisando ${v.tomadaNombre ?? 'otra persona'}.`
          : 'Abra el caso para revisarlo antes de registrar resultados.',
      );
    }
    return { base, v };
  }

  // ---------------------------------------------------------------- decisión

  /** Datos de priorización que aún faltan (los define la matriz vigente; se completa en la etapa de priorización). */
  private async variablesFaltantes(): Promise<string[]> {
    return [];
  }

  /** Enlace seguro y de vigencia limitada para que la persona consulte o corrija su caso (RNF-03). */
  private async nuevoEnlace(
    tx: Parameters<typeof tokensRepo.crear>[0],
    solicitudId: number,
    diasMinimos: number,
  ): Promise<string> {
    const dias = Math.max(
      await parametrosRepo.entero(this.deps.pool, 'enlace_seguro_dias'),
      diasMinimos,
    );
    const token = randomBytes(32).toString('base64url');
    await tokensRepo.crear(tx, {
      solicitudId,
      proposito: 'ENLACE_SEGURO',
      tokenHash: sha256(token),
      creadoAt: this.deps.ahora(),
      expiraAt: new Date(this.deps.ahora().getTime() + dias * 86_400_000),
    });
    return token;
  }

  async decidir(
    actor: Actor,
    solicitudId: number,
    entrada: { decision: DecisionValidacion; motivacion: string },
    ctx: ContextoPeticion,
  ) {
    const { pool } = this.deps;
    const [maxRondas, plazoDias, plazoRecursos] = await Promise.all([
      parametrosRepo.entero(pool, 'max_rondas_subsanacion'),
      parametrosRepo.entero(pool, 'plazo_subsanacion_dias'),
      parametrosRepo.entero(pool, 'plazo_recursos_dias'),
    ]);
    const resultado = await withTransaction(pool, async (tx) => {
      await fijarActor(tx, actor.id);
      const { base, v } = await this.exigirRevision(tx, actor, solicitudId);
      const sub = await validacionRepo.ultimaSubsanacion(tx, solicitudId, true);
      const subsanacionVencida = base.estado === 'EN_SUBSANACION' && sub?.vencida === true;
      if (base.estado !== 'EN_REVISION' && !subsanacionVencida) {
        throw conflict('CASO_NO_REVISABLE', 'Este caso no está en revisión.');
      }
      const filas = await validacionRepo.items(tx, solicitudId);
      const items: ItemChequeo[] = filas;
      const errores = erroresDeDecision(entrada.decision, items, entrada.motivacion, {
        subsanacionesPrevias: await validacionRepo.contarSubsanaciones(tx, solicitudId),
        maxRondas,
        subsanacionVencida,
        variablesFaltantes: await this.variablesFaltantes(),
      });
      if (errores.length > 0) throw errorValidacion(errores);

      const motivacion =
        entrada.decision === 'APROBAR' && entrada.motivacion.trim().length < 5
          ? 'Cumple todos los requisitos de la lista de chequeo.'
          : entrada.motivacion.trim();
      const instantanea = filas.map((i) => ({
        itemId: i.id,
        requisitoId: i.requisitoId,
        nombre: i.nombre,
        resultado: i.resultado,
        fuente: i.fuente,
        observacion: i.observacion,
        evidencia: i.evidencia,
      }));
      const decisionId = await validacionRepo.crearDecision(tx, {
        solicitudId,
        ronda: v.ronda,
        decision: entrada.decision,
        motivacion,
        items: instantanea,
        decididoPor: actor.id,
      });

      const nuevoEstado: EstadoSolicitud =
        entrada.decision === 'APROBAR'
          ? 'VALIDADA'
          : entrada.decision === 'RECHAZAR'
            ? 'NO_CUMPLE'
            : 'EN_SUBSANACION';
      await validacionRepo.fijarEstado(tx, solicitudId, nuevoEstado);
      await validacionRepo.liberar(tx, solicitudId);

      const dRes = ESTADOS[nuevoEstado];
      let venceAt: Date | null = null;
      let enlaceConsulta: string;
      if (entrada.decision === 'SUBSANAR') {
        const porCorregir = filas.filter(
          (i) => i.resultado === 'NO_CUMPLE' || i.resultado === 'PENDIENTE',
        );
        const itemsSub: ItemSubsanacion[] = porCorregir.map((i) => ({
          itemId: i.id,
          requisitoId: i.requisitoId,
          nombre: i.nombre,
          observacion: i.observacion,
          documentoId: i.documentoId,
          campos: i.campos,
        }));
        venceAt = await validacionRepo.crearSubsanacion(tx, {
          solicitudId,
          decisionId,
          items: itemsSub,
          plazoDias,
        });
        const token = await this.nuevoEnlace(tx, solicitudId, plazoDias + 1);
        enlaceConsulta = `${this.deps.env.frontendUrl}/consulta?token=${token}`;
        await this.correos.encolar(tx, {
          solicitudId,
          tipo: 'VALIDACION_SUBSANACION',
          destinatario: base.correo,
          datos: {
            nombre: base.pcd.nombre,
            radicado: base.radicado ?? '',
            motivacion,
            itemsSubsanar: textoItemsSubsanar(itemsSub),
            fechaLimite: FECHA_LARGA.format(venceAt),
            enlaceCaracterizacion: `${this.deps.env.frontendUrl}/caracterizacion?token=${token}`,
            enlaceConsulta,
          },
        });
      } else {
        const token = await this.nuevoEnlace(tx, solicitudId, 0);
        enlaceConsulta = `${this.deps.env.frontendUrl}/consulta?token=${token}`;
        if (entrada.decision === 'APROBAR') {
          await this.correos.encolar(tx, {
            solicitudId,
            tipo: 'VALIDACION_APROBADA',
            destinatario: base.correo,
            datos: {
              nombre: base.pcd.nombre,
              radicado: base.radicado ?? '',
              estado: dRes.nombre,
              siguientePaso: dRes.siguientePaso,
              enlaceConsulta,
            },
          });
        } else {
          await this.correos.encolar(tx, {
            solicitudId,
            tipo: 'VALIDACION_RECHAZADA',
            destinatario: base.correo,
            datos: {
              nombre: base.pcd.nombre,
              radicado: base.radicado ?? '',
              motivacion,
              plazoRecursosDias: plazoRecursos,
              enlaceConsulta,
            },
          });
        }
      }
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.VALIDACION,
        accion: ACCION.VALIDACION_DECIDIDA,
        entidad: 'solicitud',
        entidadId: solicitudId,
        solicitudId,
        valorAnterior: { estado: base.estado },
        valorNuevo: { estado: nuevoEstado, decision: entrada.decision },
        justificacion: motivacion,
        detalle: { ronda: v.ronda, decisionId, venceAt: venceAt?.toISOString() ?? null },
        ip: ctx.ip,
      });
      return { estado: nuevoEstado, venceAt };
    });
    this.correos.despachar();
    return {
      estado: { codigo: resultado.estado, nombre: ESTADOS[resultado.estado].nombre },
      venceAt: resultado.venceAt?.toISOString() ?? null,
      aviso: AVISO_PREINSCRIPCION,
    };
  }

  // ---------------------------------------------------------------- documentos del caso

  /** El funcionario consulta un documento del caso: solo roles con permiso sobre datos sensibles, y queda registrado. */
  async archivo(actor: Actor, solicitudId: number, documentoId: number, ctx: ContextoPeticion) {
    if (!actor.permisos.has('datos.sensibles.ver')) throw forbidden();
    const r = await this.documentos.descargar(solicitudId, documentoId);
    await bitacoraRepo.registrar(this.deps.pool, {
      usuarioId: actor.id,
      modulo: MODULO.VALIDACION,
      accion: ACCION.VALIDACION_DOCUMENTO_CONSULTADO,
      entidad: 'documento',
      entidadId: documentoId,
      solicitudId,
      detalle: { archivo: r.nombre },
      ip: ctx.ip,
    });
    return r;
  }
}
