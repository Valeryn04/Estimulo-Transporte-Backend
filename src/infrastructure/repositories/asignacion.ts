import { ESTADOS_ASIGNABLES } from '../../domain/asignacion.js';
import type { AporteVariable } from '../../domain/priorizacion.js';
import type { Queryable } from '../db/pool.js';
import type { EvidenciaGuardada } from './priorizacion.js';

export interface Finanzas {
  vigenciaId: number;
  anio: number;
  activa: boolean;
  cuposTotales: number;
  valorEstimulo: number;
  presupuestoTotal: number;
  /** Beneficios que ocupan un cupo (no finalizados). */
  ocupados: number;
  /** Beneficios finalizados: cupos que se liberaron. */
  liberados: number;
  comprometido: number;
}

export type TipoDistribucion = 'LOCALIDAD' | 'TRANSPORTE';

export interface ItemDistribucion {
  tipo: TipoDistribucion;
  itemId: number;
  nombre: string;
  cupos: number;
  ocupados: number;
}

export type TipoAjuste =
  'CUPOS' | 'VALOR_ESTIMULO' | 'PRESUPUESTO' | 'DISTRIBUCION_LOCALIDAD' | 'DISTRIBUCION_TRANSPORTE';

export interface Ajuste {
  id: number;
  vigenciaId: number;
  tipo: TipoAjuste;
  valorAnterior: unknown;
  valorNuevo: unknown;
  motivo: string;
  soporte: { nombre: string; tamanoBytes: number } | null;
  creadoPor: string;
  creadoAt: Date;
}

export interface CandidatoFila {
  solicitudId: number;
  radicado: string;
  radicadaAt: Date;
  estado: string;
  correo: string;
  pcdNombre: string;
  pcdId: number;
  cuidadorId: number | null;
  conCuidador: boolean;
  localidadId: number | null;
  localidad: string | null;
  transporteId: number | null;
  transporte: string | null;
  priorizacionId: number;
  puntaje: number;
  ajuste: number;
  aportes: Record<string, number>;
}

export type EstadoBeneficio =
  | 'PENDIENTE_ENTREGA'
  | 'PENDIENTE_ACTIVACION'
  | 'ACTIVO'
  | 'BLOQUEADO'
  | 'SUSPENDIDO'
  | 'FINALIZADO';

export interface Beneficiario {
  id: number;
  solicitudId: number;
  radicado: string;
  pcdNombre: string;
  estado: EstadoBeneficio;
  personas: number;
  valorComprometido: number;
  localidad: string | null;
  transporte: string | null;
  puntajeFinal: number;
  posicion: number;
  asignadoPor: string;
  asignadoAt: Date;
  reemplazaRadicado: string | null;
  finalizadoAt: Date | null;
  motivoFin: string | null;
  /** Entregas de tarjeta registradas y vigentes. */
  entregas: number;
}

export interface Alerta {
  id: number;
  tipo: string;
  titulo: string;
  mensaje: string;
  enlace: string | null;
  solicitudId: number | null;
  creadaAt: Date;
}

const num = (v: string | number | null): number => (v === null ? 0 : Number(v));

export const asignacionRepo = {
  /** Cupos y presupuesto de la vigencia; con `bloquear` deja la fila tomada hasta terminar la transacción. */
  async finanzas(db: Queryable, vigenciaId: number, bloquear = false): Promise<Finanzas | null> {
    const v = await db.query<{
      id: number;
      anio: number;
      activa: boolean;
      cupos_totales: number;
      valor_estimulo: string;
      presupuesto_total: string;
    }>(
      `SELECT id, anio, activa, cupos_totales, valor_estimulo, presupuesto_total
         FROM vigencias WHERE id = $1 ${bloquear ? 'FOR UPDATE' : ''}`,
      [vigenciaId],
    );
    const f = v.rows[0];
    if (!f) return null;
    const b = await db.query<{ ocupados: number; liberados: number; comprometido: string | null }>(
      `SELECT COUNT(*) FILTER (WHERE estado <> 'FINALIZADO')::int AS ocupados,
              COUNT(*) FILTER (WHERE estado = 'FINALIZADO')::int AS liberados,
              SUM(valor_comprometido) FILTER (WHERE estado <> 'FINALIZADO') AS comprometido
         FROM beneficios WHERE vigencia_id = $1`,
      [vigenciaId],
    );
    const t = b.rows[0] as { ocupados: number; liberados: number; comprometido: string | null };
    return {
      vigenciaId: f.id,
      anio: f.anio,
      activa: f.activa,
      cuposTotales: f.cupos_totales,
      valorEstimulo: num(f.valor_estimulo),
      presupuestoTotal: num(f.presupuesto_total),
      ocupados: t.ocupados,
      liberados: t.liberados,
      comprometido: num(t.comprometido),
    };
  },

  async distribucion(db: Queryable, vigenciaId: number): Promise<ItemDistribucion[]> {
    const r = await db.query<{
      tipo: TipoDistribucion;
      item_id: number;
      nombre: string;
      cupos: number;
      ocupados: number;
    }>(
      `SELECT d.tipo, d.item_id, c.nombre, d.cupos,
              (SELECT COUNT(*)::int FROM beneficios b
                WHERE b.vigencia_id = d.vigencia_id AND b.estado <> 'FINALIZADO'
                  AND ((d.tipo = 'LOCALIDAD' AND b.localidad_id = d.item_id)
                    OR (d.tipo = 'TRANSPORTE' AND b.transporte_id = d.item_id))) AS ocupados
         FROM vigencia_distribucion d JOIN catalogo_items c ON c.id = d.item_id
        WHERE d.vigencia_id = $1 ORDER BY d.tipo, c.nombre`,
      [vigenciaId],
    );
    return r.rows.map((x) => ({
      tipo: x.tipo,
      itemId: x.item_id,
      nombre: x.nombre,
      cupos: x.cupos,
      ocupados: x.ocupados,
    }));
  },

  async reemplazarDistribucion(
    db: Queryable,
    vigenciaId: number,
    tipo: TipoDistribucion,
    items: { itemId: number; cupos: number }[],
  ): Promise<void> {
    await db.query(`DELETE FROM vigencia_distribucion WHERE vigencia_id = $1 AND tipo = $2`, [
      vigenciaId,
      tipo,
    ]);
    for (const i of items) {
      await db.query(
        `INSERT INTO vigencia_distribucion (vigencia_id, tipo, item_id, cupos) VALUES ($1, $2, $3, $4)`,
        [vigenciaId, tipo, i.itemId, i.cupos],
      );
    }
  },

  /** Cuántos elementos del catálogo de ese tipo existen y están activos (para validar la distribución). */
  async itemsDeCatalogo(db: Queryable, catalogo: string, ids: number[]): Promise<number> {
    const r = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM catalogo_items WHERE catalogo = $1 AND activo AND id = ANY($2::int[])`,
      [catalogo, ids],
    );
    return (r.rows[0] as { n: number }).n;
  },

  async actualizarVigencia(
    db: Queryable,
    id: number,
    d: { cuposTotales?: number; valorEstimulo?: number; presupuestoTotal?: number },
  ): Promise<void> {
    await db.query(
      `UPDATE vigencias SET cupos_totales = COALESCE($2, cupos_totales),
              valor_estimulo = COALESCE($3, valor_estimulo), presupuesto_total = COALESCE($4, presupuesto_total)
        WHERE id = $1`,
      [id, d.cuposTotales ?? null, d.valorEstimulo ?? null, d.presupuestoTotal ?? null],
    );
  },

  async insertarAjuste(
    db: Queryable,
    a: {
      vigenciaId: number;
      tipo: TipoAjuste;
      anterior: unknown;
      nuevo: unknown;
      motivo: string;
      soporte: EvidenciaGuardada | null;
      usuarioId: number;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO cupos_ajustes (vigencia_id, tipo, valor_anterior, valor_nuevo, motivo, soporte_ruta,
                                  soporte_nombre, soporte_mime, soporte_tamano, soporte_sha256, creado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        a.vigenciaId,
        a.tipo,
        JSON.stringify(a.anterior),
        JSON.stringify(a.nuevo),
        a.motivo,
        a.soporte?.ruta ?? null,
        a.soporte?.nombre ?? null,
        a.soporte?.mime ?? null,
        a.soporte?.tamanoBytes ?? null,
        a.soporte?.sha256 ?? null,
        a.usuarioId,
      ],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  async ajustes(db: Queryable, vigenciaId: number): Promise<Ajuste[]> {
    const r = await db.query<{
      id: string;
      vigencia_id: number;
      tipo: TipoAjuste;
      valor_anterior: unknown;
      valor_nuevo: unknown;
      motivo: string;
      soporte_nombre: string | null;
      soporte_tamano: number | null;
      usuario: string;
      creado_at: Date;
    }>(
      `SELECT a.id, a.vigencia_id, a.tipo, a.valor_anterior, a.valor_nuevo, a.motivo, a.soporte_nombre,
              a.soporte_tamano, u.usuario, a.creado_at
         FROM cupos_ajustes a JOIN usuarios u ON u.id = a.creado_por
        WHERE a.vigencia_id = $1 ORDER BY a.creado_at DESC, a.id DESC LIMIT 200`,
      [vigenciaId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      vigenciaId: x.vigencia_id,
      tipo: x.tipo,
      valorAnterior: x.valor_anterior,
      valorNuevo: x.valor_nuevo,
      motivo: x.motivo,
      soporte: x.soporte_nombre
        ? { nombre: x.soporte_nombre, tamanoBytes: x.soporte_tamano as number }
        : null,
      creadoPor: x.usuario,
      creadoAt: x.creado_at,
    }));
  },

  async soporteDeAjuste(db: Queryable, id: number): Promise<EvidenciaGuardada | null> {
    const r = await db.query<{
      soporte_ruta: string | null;
      soporte_nombre: string;
      soporte_mime: string;
      soporte_tamano: number;
      soporte_sha256: string;
    }>(
      `SELECT soporte_ruta, soporte_nombre, soporte_mime, soporte_tamano, soporte_sha256
         FROM cupos_ajustes WHERE id = $1`,
      [id],
    );
    const f = r.rows[0];
    return f?.soporte_ruta
      ? {
          ruta: f.soporte_ruta,
          nombre: f.soporte_nombre,
          mime: f.soporte_mime,
          tamanoBytes: f.soporte_tamano,
          sha256: f.soporte_sha256,
        }
      : null;
  },

  // ---------------------------------------------------------------- candidatos

  /** Casos que pueden recibir el beneficio, con su puntaje vigente y el ajuste aprobado. Sin ordenar. */
  async candidatos(db: Queryable, vigenciaId: number): Promise<CandidatoFila[]> {
    const r = await db.query<{
      id: number;
      radicado: string;
      radicada_at: Date;
      estado: string;
      correo: string;
      pcd_nombre: string;
      pcd_id: number;
      cuidador_id: number;
      requiere_cuidador: boolean | null;
      localidad_id: number | null;
      localidad: string | null;
      transporte_id: number | null;
      transporte: string | null;
      priorizacion_id: string;
      puntaje: string;
      detalle: AporteVariable[];
      ajuste: string | null;
    }>(
      `SELECT s.id, s.radicado, s.radicada_at, s.estado, s.correo, p.nombre_completo AS pcd_nombre, s.pcd_id,
              s.cuidador_id, c.requiere_cuidador, s.localidad_id, loc.nombre AS localidad,
              c.tipo_transporte_id AS transporte_id, tr.nombre AS transporte,
              pr.id AS priorizacion_id, pr.puntaje, pr.detalle, ex.ajuste
         FROM solicitudes s
         JOIN personas p ON p.id = s.pcd_id
         JOIN priorizaciones pr ON pr.solicitud_id = s.id AND pr.vigente
         LEFT JOIN caracterizaciones c ON c.solicitud_id = s.id
         LEFT JOIN catalogo_items loc ON loc.id = s.localidad_id
         LEFT JOIN catalogo_items tr ON tr.id = c.tipo_transporte_id
         LEFT JOIN priorizacion_excepciones ex ON ex.priorizacion_id = pr.id AND ex.estado = 'APROBADA'
        WHERE s.vigencia_id = $1 AND s.estado = ANY($2::text[])`,
      [vigenciaId, [...ESTADOS_ASIGNABLES]],
    );
    return r.rows.map((x) => ({
      solicitudId: x.id,
      radicado: x.radicado,
      radicadaAt: x.radicada_at,
      estado: x.estado,
      correo: x.correo,
      pcdNombre: x.pcd_nombre,
      pcdId: x.pcd_id,
      cuidadorId: x.requiere_cuidador ? x.cuidador_id : null,
      conCuidador: x.requiere_cuidador === true,
      localidadId: x.localidad_id,
      localidad: x.localidad,
      transporteId: x.transporte_id,
      transporte: x.transporte,
      priorizacionId: Number(x.priorizacion_id),
      puntaje: num(x.puntaje),
      ajuste: num(x.ajuste),
      aportes: Object.fromEntries(x.detalle.map((d) => [d.variable, d.aporte])),
    }));
  },

  /** Personas que ya tienen un beneficio vigente (RN-01). */
  async personasConBeneficio(db: Queryable, personaIds: number[]): Promise<Set<number>> {
    if (personaIds.length === 0) return new Set();
    const r = await db.query<{ persona_id: number }>(
      `SELECT persona_id FROM beneficio_personas WHERE vigente AND persona_id = ANY($1::int[])`,
      [personaIds],
    );
    return new Set(r.rows.map((x) => x.persona_id));
  },

  // ---------------------------------------------------------------- beneficios

  async crearBeneficio(
    db: Queryable,
    d: {
      solicitudId: number;
      vigenciaId: number;
      personas: 1 | 2;
      valorComprometido: number;
      localidadId: number | null;
      transporteId: number | null;
      priorizacionId: number;
      puntajeFinal: number;
      posicion: number;
      usuarioId: number;
      reemplazaId: number | null;
      pcdId: number;
      cuidadorId: number | null;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO beneficios (solicitud_id, vigencia_id, personas, valor_comprometido, localidad_id, transporte_id,
                               priorizacion_id, puntaje_final, posicion, asignado_por, reemplaza_beneficio_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        d.solicitudId,
        d.vigenciaId,
        d.personas,
        d.valorComprometido,
        d.localidadId,
        d.transporteId,
        d.priorizacionId,
        d.puntajeFinal,
        d.posicion,
        d.usuarioId,
        d.reemplazaId,
      ],
    );
    const id = Number((r.rows[0] as { id: string }).id);
    await db.query(
      `INSERT INTO beneficio_personas (beneficio_id, persona_id, rol) VALUES ($1, $2, 'PCD')`,
      [id, d.pcdId],
    );
    if (d.cuidadorId !== null) {
      await db.query(
        `INSERT INTO beneficio_personas (beneficio_id, persona_id, rol) VALUES ($1, $2, 'CUIDADOR')`,
        [id, d.cuidadorId],
      );
    }
    return id;
  },

  /** El beneficio finalizado cuyo cupo se reasigna primero (el más antiguo que nadie ha ocupado). */
  async cupoLiberadoSinReasignar(db: Queryable, vigenciaId: number): Promise<number | null> {
    const r = await db.query<{ id: string }>(
      `SELECT b.id FROM beneficios b
        WHERE b.vigencia_id = $1 AND b.estado = 'FINALIZADO'
          AND NOT EXISTS (SELECT 1 FROM beneficios n WHERE n.reemplaza_beneficio_id = b.id)
        ORDER BY b.finalizado_at, b.id LIMIT 1`,
      [vigenciaId],
    );
    return r.rows[0] ? Number(r.rows[0].id) : null;
  },

  async beneficio(
    db: Queryable,
    id: number,
  ): Promise<{
    id: number;
    solicitudId: number;
    vigenciaId: number;
    estado: EstadoBeneficio;
    radicado: string;
  } | null> {
    const r = await db.query<{
      id: string;
      solicitud_id: number;
      vigencia_id: number;
      estado: EstadoBeneficio;
      radicado: string;
    }>(
      `SELECT b.id, b.solicitud_id, b.vigencia_id, b.estado, s.radicado
         FROM beneficios b JOIN solicitudes s ON s.id = b.solicitud_id WHERE b.id = $1 FOR UPDATE OF b`,
      [id],
    );
    const f = r.rows[0];
    return f
      ? {
          id: Number(f.id),
          solicitudId: f.solicitud_id,
          vigenciaId: f.vigencia_id,
          estado: f.estado,
          radicado: f.radicado,
        }
      : null;
  },

  /** Finaliza el beneficio: libera el cupo y deja a las personas libres de RN-01. */
  async finalizar(db: Queryable, id: number, motivo: string): Promise<void> {
    await db.query(
      `UPDATE beneficios SET estado = 'FINALIZADO', finalizado_at = now(), motivo_fin = $2 WHERE id = $1`,
      [id, motivo],
    );
    await db.query(`UPDATE beneficio_personas SET vigente = false WHERE beneficio_id = $1`, [id]);
    // Las tarjetas quedan libres para otro beneficiario.
    await db.query(`UPDATE entregas SET vigente = false WHERE beneficio_id = $1 AND vigente`, [id]);
  },

  async beneficiarios(
    db: Queryable,
    f: { vigenciaId: number; estado?: EstadoBeneficio; q?: string; limit: number; offset: number },
  ): Promise<{ items: Beneficiario[]; total: number }> {
    const params: unknown[] = [f.vigenciaId];
    const where = ['b.vigencia_id = $1'];
    if (f.estado) {
      params.push(f.estado);
      where.push(`b.estado = $${params.length}`);
    }
    if (f.q) {
      params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(
        `(s.radicado ILIKE $${params.length} OR p.nombre_completo ILIKE $${params.length})`,
      );
    }
    params.push(f.limit, f.offset);
    const r = await db.query<{
      id: string;
      solicitud_id: number;
      radicado: string;
      pcd_nombre: string;
      estado: EstadoBeneficio;
      personas: number;
      valor_comprometido: string;
      localidad: string | null;
      transporte: string | null;
      puntaje_final: string;
      posicion: number;
      asignado_por: string;
      asignado_at: Date;
      reemplaza_radicado: string | null;
      finalizado_at: Date | null;
      motivo_fin: string | null;
      entregas: number;
      total: number;
    }>(
      `SELECT b.id, b.solicitud_id, s.radicado, p.nombre_completo AS pcd_nombre, b.estado, b.personas,
              b.valor_comprometido, loc.nombre AS localidad, tr.nombre AS transporte, b.puntaje_final, b.posicion,
              u.usuario AS asignado_por, b.asignado_at, rs.radicado AS reemplaza_radicado, b.finalizado_at,
              b.motivo_fin,
              (SELECT COUNT(*)::int FROM entregas en WHERE en.beneficio_id = b.id AND en.vigente) AS entregas,
              COUNT(*) OVER()::int AS total
         FROM beneficios b
         JOIN solicitudes s ON s.id = b.solicitud_id
         JOIN personas p ON p.id = s.pcd_id
         JOIN usuarios u ON u.id = b.asignado_por
         LEFT JOIN catalogo_items loc ON loc.id = b.localidad_id
         LEFT JOIN catalogo_items tr ON tr.id = b.transporte_id
         LEFT JOIN beneficios rb ON rb.id = b.reemplaza_beneficio_id
         LEFT JOIN solicitudes rs ON rs.id = rb.solicitud_id
        WHERE ${where.join(' AND ')}
        ORDER BY b.asignado_at DESC, b.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: r.rows.map((x) => ({
        id: Number(x.id),
        solicitudId: x.solicitud_id,
        radicado: x.radicado,
        pcdNombre: x.pcd_nombre,
        estado: x.estado,
        personas: x.personas,
        valorComprometido: num(x.valor_comprometido),
        localidad: x.localidad,
        transporte: x.transporte,
        puntajeFinal: num(x.puntaje_final),
        posicion: x.posicion,
        asignadoPor: x.asignado_por,
        asignadoAt: x.asignado_at,
        reemplazaRadicado: x.reemplaza_radicado,
        finalizadoAt: x.finalizado_at,
        motivoFin: x.motivo_fin,
        entregas: x.entregas,
      })),
      total: r.rows[0]?.total ?? 0,
    };
  },

  async insertarOmision(
    db: Queryable,
    o: {
      solicitudId: number;
      posicion: number;
      puntajeFinal: number;
      causa: string;
      usuarioId: number;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO asignacion_omisiones (solicitud_id, posicion, puntaje_final, causa, registrado_por)
       VALUES ($1, $2, $3, $4, $5)`,
      [o.solicitudId, o.posicion, o.puntajeFinal, o.causa, o.usuarioId],
    );
  },

  async omisiones(
    db: Queryable,
    solicitudId: number,
  ): Promise<{ posicion: number; causa: string; registradoPor: string; registradoAt: Date }[]> {
    const r = await db.query<{
      posicion: number;
      causa: string;
      usuario: string;
      registrado_at: Date;
    }>(
      `SELECT o.posicion, o.causa, u.usuario, o.registrado_at FROM asignacion_omisiones o
         JOIN usuarios u ON u.id = o.registrado_por WHERE o.solicitud_id = $1 ORDER BY o.registrado_at DESC`,
      [solicitudId],
    );
    return r.rows.map((x) => ({
      posicion: x.posicion,
      causa: x.causa,
      registradoPor: x.usuario,
      registradoAt: x.registrado_at,
    }));
  },
};

// ---------------------------------------------------------------------------------------------------------
// Avisos internos
// ---------------------------------------------------------------------------------------------------------

export const alertasRepo = {
  /** Crea el aviso; si ya hay uno pendiente con la misma clave no hace nada. */
  async crear(
    db: Queryable,
    a: {
      tipo: string;
      permisoDestino: string;
      titulo: string;
      mensaje: string;
      enlace?: string | null;
      solicitudId?: number | null;
      beneficioId?: number | null;
      clave?: string | null;
      /** Si se indica, el aviso es solo de esa persona (y no de todos los que tienen el permiso). */
      usuarioDestino?: number | null;
    },
  ): Promise<void> {
    await db.query(
      `INSERT INTO alertas (tipo, permiso_destino, titulo, mensaje, enlace, solicitud_id, beneficio_id, clave, usuario_destino)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [
        a.tipo,
        a.permisoDestino,
        a.titulo,
        a.mensaje,
        a.enlace ?? null,
        a.solicitudId ?? null,
        a.beneficioId ?? null,
        a.clave ?? null,
        a.usuarioDestino ?? null,
      ],
    );
  },

  async pendientes(
    db: Queryable,
    permisos: string[],
    usuarioId: number,
    limite = 50,
  ): Promise<Alerta[]> {
    const r = await db.query<{
      id: string;
      tipo: string;
      titulo: string;
      mensaje: string;
      enlace: string | null;
      solicitud_id: number | null;
      creada_at: Date;
    }>(
      `SELECT id, tipo, titulo, mensaje, enlace, solicitud_id, creada_at FROM alertas
        WHERE atendida_at IS NULL
          AND ((usuario_destino IS NULL AND permiso_destino = ANY($1::text[])) OR usuario_destino = $3)
          AND NOT EXISTS (SELECT 1 FROM alerta_lecturas l WHERE l.alerta_id = alertas.id AND l.usuario_id = $3)
        ORDER BY creada_at DESC, id DESC LIMIT $2`,
      [permisos, limite, usuarioId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      tipo: x.tipo,
      titulo: x.titulo,
      mensaje: x.mensaje,
      enlace: x.enlace,
      solicitudId: x.solicitud_id,
      creadaAt: x.creada_at,
    }));
  },

  /** Marca el aviso como atendido si va dirigido a alguno de los permisos de quien lo atiende. */
  async atender(
    db: Queryable,
    id: number,
    permisos: string[],
    usuarioId: number,
  ): Promise<boolean> {
    // La lectura es de cada persona: el aviso sigue pendiente para los demás del mismo rol.
    const r = await db.query(
      `INSERT INTO alerta_lecturas (alerta_id, usuario_id)
       SELECT id, $3 FROM alertas
        WHERE id = $1 AND atendida_at IS NULL
          AND ((usuario_destino IS NULL AND permiso_destino = ANY($2::text[])) OR usuario_destino = $3)
       ON CONFLICT DO NOTHING`,
      [id, permisos, usuarioId],
    );
    return r.rowCount === 1;
  },
};
