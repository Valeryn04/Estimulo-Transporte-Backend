import { createHash } from 'node:crypto';
import { ACCION, MODULO } from '../domain/acciones.js';
import { withTransaction } from '../infrastructure/db/pool.js';
import { bitacoraRepo } from '../infrastructure/repositories/bitacora.js';
import { parametrosRepo } from '../infrastructure/repositories/parametros.js';
import {
  exportacionesRepo,
  REPORTES,
  reportesRepo,
  type CodigoReporte,
  type FiltroReporte,
  type TablaReporte,
} from '../infrastructure/repositories/reportes.js';
import {
  biRepo,
  bitacoraConsultaRepo,
  expedienteRepo,
  tableroRepo,
  type FiltroBitacora,
  type FiltroTablero,
} from '../infrastructure/repositories/seguimiento.js';
import { notFound } from '../shared/errors.js';
import type { Actor, ContextoPeticion, Dependencias } from './contexto.js';
import type { ServicioEncuestas } from './encuestas.js';
import { aCsv, aExcel, aPdf, type EncabezadoReporte } from './exportacion.js';

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const pct = (parte: number, total: number) => (total === 0 ? 0 : Math.round((parte / total) * 1000) / 10);
const ocultar = (numero: string) => `***${numero.slice(-3)}`;

/**
 * Seguimiento y control del programa: consulta de la bitácora (RF-SEG-01), expediente integral (RF-SEG-03), tablero
 * (RF-SEG-04), reportes exportables con registro de cada exportación (RF-SEG-05/06) y eventos para BI (RF-SEG-07).
 */
export class ServicioSeguimiento {
  constructor(
    private readonly deps: Dependencias,
    private readonly encuestas: ServicioEncuestas,
  ) {}

  // ------------------------------------------------------------------------------------------------------- bitácora

  async bitacora(actor: Actor, f: FiltroBitacora, ctx: ContextoPeticion) {
    const { items, total } = await bitacoraConsultaRepo.consultar(this.deps.pool, f);
    const verSensibles = actor.permisos.has('datos.sensibles.ver');
    // Consultar la bitácora también deja rastro: quién miró qué y con qué filtros.
    await bitacoraRepo.registrar(this.deps.pool, {
      usuarioId: actor.id,
      modulo: MODULO.SEGUIMIENTO,
      accion: ACCION.BITACORA_CONSULTADA,
      entidad: 'bitacora',
      detalle: {
        filtros: { ...f, limit: undefined, offset: undefined },
        resultados: total,
      },
      ip: ctx.ip,
    });
    return {
      total,
      sensiblesOcultos: !verSensibles,
      items: items.map((x) => ({
        id: x.id,
        fecha: x.creadoAt.toISOString(),
        usuario: x.usuario,
        modulo: x.modulo,
        accion: x.accion,
        entidad: x.entidad,
        entidadId: x.entidadId,
        radicado: x.radicado,
        justificacion: x.justificacion,
        ip: x.ip,
        // Los valores pueden contener datos personales: solo los ve quien tiene permiso sobre datos sensibles.
        anterior: verSensibles ? x.valorAnterior : null,
        nuevo: verSensibles ? x.valorNuevo : null,
        detalle: verSensibles ? x.detalle : null,
      })),
    };
  }

  modulosBitacora() {
    return bitacoraConsultaRepo.modulos(this.deps.pool);
  }

  // ----------------------------------------------------------------------------------------------------- expediente

  buscarExpedientes(q: string) {
    return expedienteRepo.buscar(this.deps.pool, q, 20);
  }

  async expediente(actor: Actor, solicitudId: number, ctx: ContextoPeticion) {
    const pool = this.deps.pool;
    const r = await expedienteRepo.resumen(pool, solicitudId);
    if (!r) throw notFound('Solicitud no encontrada');
    const verSensibles = actor.permisos.has('datos.sensibles.ver');
    const [eventos, comunicaciones, documentos, otras] = await Promise.all([
      expedienteRepo.eventosDeBitacora(pool, solicitudId),
      expedienteRepo.comunicaciones(pool, solicitudId),
      expedienteRepo.documentos(pool, solicitudId),
      expedienteRepo.otrasVigencias(pool, r.pcd.id, solicitudId),
    ]);

    const cronologia = [
      ...eventos.map((e) => ({
        fecha: e.fecha.toISOString(),
        origen: 'bitacora' as const,
        modulo: e.modulo,
        accion: e.accion,
        usuario: e.usuario,
        justificacion: e.justificacion,
        anterior: verSensibles ? e.anterior : null,
        nuevo: verSensibles ? e.nuevo : null,
      })),
      ...comunicaciones.map((c) => ({
        fecha: c.fecha.toISOString(),
        origen: 'correo' as const,
        modulo: 'comunicaciones',
        accion: c.tipo,
        usuario: null,
        justificacion: c.asunto,
        anterior: null,
        nuevo: { estado: c.estado },
      })),
    ].sort((a, b) => a.fecha.localeCompare(b.fecha));

    await bitacoraRepo.registrar(pool, {
      usuarioId: actor.id,
      modulo: MODULO.SEGUIMIENTO,
      accion: ACCION.EXPEDIENTE_CONSULTADO,
      entidad: 'solicitud',
      entidadId: solicitudId,
      solicitudId,
      ip: ctx.ip,
    });

    const persona = (p: { id: number; nombre: string; tipo: string; numero: string }) => ({
      nombre: p.nombre,
      tipoIdentificacion: p.tipo,
      numeroIdentificacion: verSensibles ? p.numero : ocultar(p.numero),
    });
    return {
      solicitudId: r.solicitudId,
      radicado: r.radicado,
      estado: r.estado,
      vigencia: r.anio,
      localidad: r.localidad,
      barrio: r.barrio,
      correo: verSensibles ? r.correo : null,
      creadaAt: r.creadaAt.toISOString(),
      correoVerificadoAt: iso(r.correoVerificadoAt),
      radicadaAt: iso(r.radicadaAt),
      pcd: persona(r.pcd),
      cuidador: r.cuidador ? persona(r.cuidador) : null,
      puntaje: r.puntaje,
      beneficio: r.beneficio
        ? { id: r.beneficio.id, estado: r.beneficio.estado, asignadoAt: r.beneficio.asignadoAt.toISOString() }
        : null,
      documentos: documentos.map((d) => ({ ...d, cargadoAt: d.cargadoAt.toISOString() })),
      otrasVigencias: otras,
      cronologia,
      sensiblesOcultos: !verSensibles,
    };
  }

  // ------------------------------------------------------------------------------------------------------- tablero

  private async vigenciaPorDefecto(): Promise<number> {
    const r = await this.deps.pool.query<{ id: number }>(
      `SELECT id FROM vigencias ORDER BY activa DESC, anio DESC LIMIT 1`,
    );
    const id = r.rows[0]?.id;
    if (!id) throw notFound('No hay vigencias configuradas');
    return id;
  }

  async tablero(f: Omit<FiltroTablero, 'vigenciaId'> & { vigenciaId?: number }) {
    const pool = this.deps.pool;
    const vigenciaId = f.vigenciaId ?? (await this.vigenciaPorDefecto());
    const filtro: FiltroTablero = { ...f, vigenciaId };
    const [ind, tiempos, presupuesto, localidades, meta, encuestaId] = await Promise.all([
      tableroRepo.indicadores(pool, filtro),
      tableroRepo.tiempos(pool, filtro),
      tableroRepo.presupuesto(pool, vigenciaId),
      tableroRepo.porLocalidad(pool, vigenciaId),
      parametrosRepo.entero(pool, 'meta_beneficiarios'),
      tableroRepo.ultimaEncuestaConRespuestas(pool),
    ]);
    const satisfaccion = encuestaId ? (await this.encuestas.resultados(encuestaId)).satisfaccion : null;
    const vigencia = await pool.query<{ anio: number }>(`SELECT anio FROM vigencias WHERE id = $1`, [vigenciaId]);
    return {
      vigenciaId,
      vigencia: vigencia.rows[0]?.anio ?? null,
      embudo: {
        preinscritos: ind.preinscritos,
        caracterizados: ind.caracterizados,
        validados: ind.validados,
        rechazados: ind.rechazados,
        priorizados: ind.priorizados,
        asignados: ind.asignados,
        listaEspera: ind.lista_espera,
        activos: ind.activos,
        entregas: ind.entregas,
      },
      novedades: { bloqueos: ind.bloqueos, levantamientos: ind.levantamientos, revocatorias: ind.revocatorias },
      avance: {
        meta,
        asignadosVigentes: ind.asignados_vigentes,
        porcentaje: pct(ind.asignados_vigentes, meta),
      },
      presupuesto: presupuesto
        ? {
            total: presupuesto.total,
            comprometido: presupuesto.comprometido,
            disponible: Math.max(presupuesto.total - presupuesto.comprometido, 0),
            porcentaje: pct(presupuesto.comprometido, presupuesto.total),
            cupos: presupuesto.cupos,
          }
        : null,
      tiemposPromedioDias: tiempos,
      satisfaccion,
      porLocalidad: localidades,
    };
  }

  // ------------------------------------------------------------------------------------------------------ reportes

  catalogoReportes() {
    return REPORTES.map((r) => ({ ...r }));
  }

  private async resolverFiltro(f: Omit<FiltroReporte, 'vigenciaId'> & { vigenciaId?: number }): Promise<FiltroReporte> {
    return { ...f, vigenciaId: f.vigenciaId ?? (await this.vigenciaPorDefecto()) };
  }

  private async textoDeFiltros(f: FiltroReporte): Promise<string[]> {
    const pool = this.deps.pool;
    const [vig, loc] = await Promise.all([
      pool.query<{ anio: number }>(`SELECT anio FROM vigencias WHERE id = $1`, [f.vigenciaId]),
      f.localidadId
        ? pool.query<{ nombre: string }>(`SELECT nombre FROM catalogo_items WHERE id = $1`, [f.localidadId])
        : Promise.resolve(null),
    ]);
    const lineas = [`Vigencia: ${vig.rows[0]?.anio ?? f.vigenciaId}`];
    if (f.desde || f.hasta) lineas.push(`Periodo: ${f.desde ?? 'inicio'} a ${f.hasta ?? 'hoy'}`);
    if (loc) lineas.push(`Localidad: ${loc.rows[0]?.nombre ?? f.localidadId}`);
    if (f.estado) lineas.push(`Estado: ${f.estado}`);
    if (f.poblacion) lineas.push(`Población: ${f.poblacion === 'CON_CUIDADOR' ? 'con cuidador' : 'sin cuidador'}`);
    return lineas;
  }

  private nombreDe(codigo: CodigoReporte) {
    return REPORTES.find((r) => r.codigo === codigo)!.nombre;
  }

  async vistaPrevia(
    actor: Actor,
    codigo: CodigoReporte,
    filtros: Omit<FiltroReporte, 'vigenciaId'> & { vigenciaId?: number },
  ): Promise<TablaReporte & { reporte: string; nombre: string; filtros: string[]; total: number }> {
    const f = await this.resolverFiltro(filtros);
    const tabla = await reportesRepo.generar(this.deps.pool, codigo, f, {
      verSensibles: actor.permisos.has('datos.sensibles.ver'),
    });
    return {
      reporte: codigo,
      nombre: this.nombreDe(codigo),
      filtros: await this.textoDeFiltros(f),
      total: tabla.filas.length,
      columnas: tabla.columnas,
      // La vista previa muestra una muestra: el archivo exportado lleva todas las filas.
      filas: tabla.filas.slice(0, 200),
    };
  }

  async exportar(
    actor: Actor,
    codigo: CodigoReporte,
    formato: 'XLSX' | 'PDF',
    filtros: Omit<FiltroReporte, 'vigenciaId'> & { vigenciaId?: number },
    ctx: ContextoPeticion,
  ) {
    const f = await this.resolverFiltro(filtros);
    const tabla = await reportesRepo.generar(this.deps.pool, codigo, f, {
      verSensibles: actor.permisos.has('datos.sensibles.ver'),
    });
    const ahora = this.deps.ahora();
    const enc: EncabezadoReporte = {
      titulo: this.nombreDe(codigo),
      filtros: await this.textoDeFiltros(f),
      generadoPor: actor.usuario,
      generadoAt: ahora,
    };
    const archivo = formato === 'XLSX' ? await aExcel(tabla, enc) : await aPdf(tabla, enc);
    const nombre = `${codigo.toLowerCase()}-${ahora.toISOString().slice(0, 10)}.${formato === 'XLSX' ? 'xlsx' : 'pdf'}`;
    const sha256 = createHash('sha256').update(archivo).digest('hex');
    await withTransaction(this.deps.pool, async (tx) => {
      const id = await exportacionesRepo.registrar(tx, {
        usuarioId: actor.id,
        reporte: codigo,
        formato,
        filtros: f,
        filas: tabla.filas.length,
        archivoNombre: nombre,
        archivoSha256: sha256,
      });
      await bitacoraRepo.registrar(tx, {
        usuarioId: actor.id,
        modulo: MODULO.SEGUIMIENTO,
        accion: ACCION.REPORTE_EXPORTADO,
        entidad: 'exportacion',
        entidadId: id,
        detalle: { reporte: codigo, formato, filas: tabla.filas.length, sha256 },
        ip: ctx.ip,
      });
    });
    return {
      archivo,
      nombre,
      tipo:
        formato === 'XLSX'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'application/pdf',
    };
  }

  async exportaciones() {
    const items = await exportacionesRepo.listar(this.deps.pool, 100);
    return {
      items: items.map((x) => ({
        id: x.id,
        usuario: x.usuario,
        reporte: x.reporte,
        nombre: REPORTES.find((r) => r.codigo === x.reporte)?.nombre ?? x.reporte,
        formato: x.formato,
        filtros: x.filtros,
        filas: x.filas,
        archivo: x.archivoNombre,
        sha256: x.archivoSha256,
        fecha: x.creadaAt.toISOString(),
      })),
    };
  }

  // ----------------------------------------------------------------------------------------------------------- BI

  async eventosBi(
    actor: Actor,
    f: { desde?: string; hasta?: string; despuesDe?: number; limite: number },
    ctx: ContextoPeticion,
  ) {
    const eventos = await biRepo.eventos(this.deps.pool, f);
    await bitacoraRepo.registrar(this.deps.pool, {
      usuarioId: actor.id,
      modulo: MODULO.SEGUIMIENTO,
      accion: ACCION.BI_CONSULTADO,
      entidad: 'bi_eventos',
      detalle: { ...f, entregados: eventos.length },
      ip: ctx.ip,
    });
    return {
      items: eventos.map((e) => ({ ...e, ocurridoAt: e.ocurridoAt.toISOString() })),
      // Para pedir la siguiente página basta con enviar este valor en `despuesDe`.
      siguiente: eventos.length === f.limite ? (eventos.at(-1)?.eventoId ?? null) : null,
    };
  }

  async eventosBiCsv(
    actor: Actor,
    f: { desde?: string; hasta?: string; despuesDe?: number; limite: number },
    ctx: ContextoPeticion,
  ): Promise<string> {
    const { items } = await this.eventosBi(actor, f, ctx);
    return aCsv(
      [
        { clave: 'eventoId', titulo: 'evento_id' },
        { clave: 'ocurridoAt', titulo: 'ocurrido_at' },
        { clave: 'tipoEvento', titulo: 'tipo_evento' },
        { clave: 'etapa', titulo: 'etapa' },
        { clave: 'estado', titulo: 'estado' },
        { clave: 'localidad', titulo: 'localidad' },
        { clave: 'vigencia', titulo: 'vigencia' },
        { clave: 'usuarioRef', titulo: 'usuario_ref' },
        { clave: 'casoRef', titulo: 'caso_ref' },
      ],
      items,
    );
  }
}
