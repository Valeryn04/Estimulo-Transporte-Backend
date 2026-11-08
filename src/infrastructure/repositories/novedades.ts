import type { Queryable } from '../db/pool.js';
import type { EstadoBeneficio } from './asignacion.js';
import type { EvidenciaGuardada } from './priorizacion.js';

export type TipoNovedad = 'BLOQUEO' | 'SUSPENSION' | 'LEVANTAMIENTO' | 'FINALIZACION';

export interface Novedad {
  id: number;
  beneficioId: number;
  tipo: TipoNovedad;
  causal: string | null;
  fechaEfectiva: string;
  observacion: string;
  /** Archivo opcional: la justificación es lo único obligatorio. */
  evidencia: { nombre: string; tamanoBytes: number } | null;
  responsable: string;
  correoId: number | null;
  levantamientoProgramado: string | null;
  levantaNovedadId: number | null;
  estadoPrevio: string;
  creadaAt: Date;
  /** Bloqueo o suspensión que todavía no se levantó. */
  abierta: boolean;
}

const SELECT_NOVEDAD = `SELECT n.id, n.beneficio_id, n.tipo, c.nombre AS causal, to_char(n.fecha_efectiva, 'YYYY-MM-DD') AS fecha_efectiva,
       n.observacion, n.evidencia_nombre, n.evidencia_tamano, u.usuario AS responsable, n.correo_id,
       to_char(n.levantamiento_programado, 'YYYY-MM-DD') AS levantamiento_programado, n.levanta_novedad_id,
       n.estado_previo, n.created_at,
       (n.tipo IN ('BLOQUEO', 'SUSPENSION') AND NOT EXISTS (SELECT 1 FROM novedades l WHERE l.levanta_novedad_id = n.id)) AS abierta
  FROM novedades n
  LEFT JOIN catalogo_items c ON c.id = n.causal_id
  JOIN usuarios u ON u.id = n.responsable_id`;

interface FilaNovedad {
  id: string;
  beneficio_id: string;
  tipo: TipoNovedad;
  causal: string | null;
  fecha_efectiva: string;
  observacion: string;
  evidencia_nombre: string | null;
  evidencia_tamano: number | null;
  responsable: string;
  correo_id: string | null;
  levantamiento_programado: string | null;
  levanta_novedad_id: string | null;
  estado_previo: string;
  created_at: Date;
  abierta: boolean;
}

const mapearNovedad = (f: FilaNovedad): Novedad => ({
  id: Number(f.id),
  beneficioId: Number(f.beneficio_id),
  tipo: f.tipo,
  causal: f.causal,
  fechaEfectiva: f.fecha_efectiva,
  observacion: f.observacion,
  evidencia:
    f.evidencia_nombre !== null
      ? { nombre: f.evidencia_nombre, tamanoBytes: f.evidencia_tamano ?? 0 }
      : null,
  responsable: f.responsable,
  correoId: f.correo_id === null ? null : Number(f.correo_id),
  levantamientoProgramado: f.levantamiento_programado,
  levantaNovedadId: f.levanta_novedad_id === null ? null : Number(f.levanta_novedad_id),
  estadoPrevio: f.estado_previo,
  creadaAt: f.created_at,
  abierta: f.abierta,
});

export const novedadesRepo = {
  async delBeneficio(db: Queryable, beneficioId: number): Promise<Novedad[]> {
    const r = await db.query<FilaNovedad>(
      `${SELECT_NOVEDAD} WHERE n.beneficio_id = $1 ORDER BY n.created_at, n.id`,
      [beneficioId],
    );
    return r.rows.map(mapearNovedad);
  },

  async abierta(db: Queryable, beneficioId: number): Promise<Novedad | null> {
    const r = await db.query<FilaNovedad>(
      `SELECT * FROM (${SELECT_NOVEDAD} WHERE n.beneficio_id = $1) x WHERE x.abierta ORDER BY x.created_at DESC LIMIT 1`,
      [beneficioId],
    );
    return r.rows[0] ? mapearNovedad(r.rows[0]) : null;
  },

  async porId(db: Queryable, id: number): Promise<Novedad | null> {
    const r = await db.query<FilaNovedad>(`${SELECT_NOVEDAD} WHERE n.id = $1`, [id]);
    return r.rows[0] ? mapearNovedad(r.rows[0]) : null;
  },

  async crear(
    db: Queryable,
    d: {
      beneficioId: number;
      tipo: TipoNovedad;
      causalId: number | null;
      fechaEfectiva: string;
      observacion: string;
      evidencia: EvidenciaGuardada | null;
      usuarioId: number;
      levantamientoProgramado: string | null;
      levantaNovedadId: number | null;
      estadoPrevio: string;
      correoId: number | null;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO novedades (beneficio_id, tipo, causal_id, fecha_efectiva, observacion, evidencia_ruta,
                              evidencia_nombre, evidencia_mime, evidencia_tamano, evidencia_sha256, responsable_id,
                              levantamiento_programado, levanta_novedad_id, estado_previo, correo_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING id`,
      [
        d.beneficioId,
        d.tipo,
        d.causalId,
        d.fechaEfectiva,
        d.observacion,
        d.evidencia?.ruta ?? null,
        d.evidencia?.nombre ?? null,
        d.evidencia?.mime ?? null,
        d.evidencia?.tamanoBytes ?? null,
        d.evidencia?.sha256 ?? null,
        d.usuarioId,
        d.levantamientoProgramado,
        d.levantaNovedadId,
        d.estadoPrevio,
        d.correoId,
      ],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  async evidencia(db: Queryable, id: number): Promise<EvidenciaGuardada | null> {
    const r = await db.query<{
      evidencia_ruta: string;
      evidencia_nombre: string;
      evidencia_mime: string;
      evidencia_tamano: number;
      evidencia_sha256: string;
    }>(
      `SELECT evidencia_ruta, evidencia_nombre, evidencia_mime, evidencia_tamano, evidencia_sha256 FROM novedades WHERE id = $1`,
      [id],
    );
    const f = r.rows[0];
    return f
      ? {
          ruta: f.evidencia_ruta,
          nombre: f.evidencia_nombre,
          mime: f.evidencia_mime,
          tamanoBytes: f.evidencia_tamano,
          sha256: f.evidencia_sha256,
        }
      : null;
  },

  /** Bloqueos y suspensiones abiertos cuya fecha de levantamiento programada ya llegó. */
  async levantamientosVencidos(
    db: Queryable,
  ): Promise<{ id: number; beneficioId: number; radicado: string; fecha: string }[]> {
    const r = await db.query<{ id: string; beneficio_id: string; radicado: string; fecha: string }>(
      `SELECT n.id, n.beneficio_id, s.radicado, to_char(n.levantamiento_programado, 'YYYY-MM-DD') AS fecha
         FROM novedades n
         JOIN beneficios b ON b.id = n.beneficio_id
         JOIN solicitudes s ON s.id = b.solicitud_id
        WHERE n.tipo IN ('BLOQUEO', 'SUSPENSION') AND n.levantamiento_programado IS NOT NULL
          AND n.levantamiento_programado <= hoy_bogota()
          AND NOT EXISTS (SELECT 1 FROM novedades l WHERE l.levanta_novedad_id = n.id)`,
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      beneficioId: Number(x.beneficio_id),
      radicado: x.radicado,
      fecha: x.fecha,
    }));
  },

  async causalDe(
    db: Queryable,
    catalogo: string,
    id: number,
  ): Promise<{ nombre: string; codigo: string } | null> {
    const r = await db.query<{ nombre: string; codigo: string }>(
      `SELECT nombre, codigo FROM catalogo_items WHERE id = $1 AND catalogo = $2 AND activo`,
      [id, catalogo],
    );
    return r.rows[0] ?? null;
  },

  async causalPorCodigo(
    db: Queryable,
    catalogo: string,
    codigo: string,
  ): Promise<{ id: number; nombre: string } | null> {
    const r = await db.query<{ id: number; nombre: string }>(
      `SELECT id, nombre FROM catalogo_items WHERE catalogo = $1 AND codigo = $2 AND activo`,
      [catalogo, codigo],
    );
    return r.rows[0] ?? null;
  },

  async causalesConCodigo(
    db: Queryable,
    catalogo: string,
  ): Promise<{ codigo: string; nombre: string }[]> {
    const r = await db.query<{ codigo: string; nombre: string }>(
      `SELECT codigo, nombre FROM catalogo_items WHERE catalogo = $1 AND activo ORDER BY nombre`,
      [catalogo],
    );
    return r.rows;
  },

  async causales(db: Queryable, catalogo: string): Promise<{ id: number; nombre: string }[]> {
    const r = await db.query<{ id: number; nombre: string }>(
      `SELECT id, nombre FROM catalogo_items WHERE catalogo = $1 AND activo ORDER BY nombre`,
      [catalogo],
    );
    return r.rows;
  },

  /** Listado de beneficios con su última novedad, para el gestor. */
  async resumen(
    db: Queryable,
    f: { estado?: EstadoBeneficio; q?: string; limit: number; offset: number },
  ): Promise<{ items: ResumenNovedades[]; total: number }> {
    const params: unknown[] = [];
    const where = [
      "b.estado <> 'FINALIZADO' OR EXISTS (SELECT 1 FROM novedades x WHERE x.beneficio_id = b.id)",
    ];
    const cond: string[] = [`(${where[0]})`];
    if (f.estado) {
      params.push(f.estado);
      cond.push(`b.estado = $${params.length}`);
    }
    if (f.q) {
      params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
      cond.push(
        `(s.radicado ILIKE $${params.length} OR p.nombre_completo ILIKE $${params.length})`,
      );
    }
    params.push(f.limit, f.offset);
    const r = await db.query<{
      id: string;
      radicado: string;
      pcd_nombre: string;
      estado: EstadoBeneficio;
      novedades: number;
      revocatoria: string | null;
      total: number;
    }>(
      `SELECT b.id, s.radicado, p.nombre_completo AS pcd_nombre, b.estado,
              (SELECT COUNT(*)::int FROM novedades n WHERE n.beneficio_id = b.id) AS novedades,
              (SELECT r.estado FROM revocatorias r WHERE r.beneficio_id = b.id AND r.estado <> 'DECIDIDA' LIMIT 1) AS revocatoria,
              COUNT(*) OVER()::int AS total
         FROM beneficios b
         JOIN solicitudes s ON s.id = b.solicitud_id
         JOIN personas p ON p.id = s.pcd_id
        WHERE ${cond.join(' AND ')}
        ORDER BY (b.estado IN ('BLOQUEADO', 'SUSPENDIDO')) DESC, b.asignado_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: r.rows.map((x) => ({
        beneficioId: Number(x.id),
        radicado: x.radicado,
        pcdNombre: x.pcd_nombre,
        estado: x.estado,
        novedades: x.novedades,
        revocatoria: x.revocatoria,
      })),
      total: r.rows[0]?.total ?? 0,
    };
  },
};

export interface ResumenNovedades {
  beneficioId: number;
  radicado: string;
  pcdNombre: string;
  estado: EstadoBeneficio;
  novedades: number;
  /** Estado de la revocatoria en curso, si la hay. */
  revocatoria: string | null;
}

// ---------------------------------------------------------------------------------------------------------
// Revocatorias
// ---------------------------------------------------------------------------------------------------------

export type EstadoRevocatoria = 'INICIADA' | 'EN_TRASLADO' | 'CON_DESCARGOS' | 'DECIDIDA';
export type EtapaRevocatoria = 'INICIO' | 'TRASLADO' | 'DESCARGOS' | 'SIN_DESCARGOS' | 'ACTO';

export interface Revocatoria {
  id: number;
  beneficioId: number;
  radicado: string;
  pcdNombre: string;
  solicitudId: number;
  correo: string;
  causalId: number;
  causal: string;
  descripcion: string;
  estado: EstadoRevocatoria;
  resultado: 'REVOCADA' | 'ARCHIVADA' | null;
  trasladoAt: Date | null;
  venceDescargosAt: Date | null;
  descargosAt: Date | null;
  sinDescargos: boolean;
  decididaAt: Date | null;
  iniciadaPor: string;
  creadaAt: Date;
}

export interface EventoRevocatoria {
  id: number;
  etapa: EtapaRevocatoria;
  texto: string;
  fecha: string;
  referencia: string | null;
  evidencia: { nombre: string; tamanoBytes: number } | null;
  usuario: string;
  correoId: number | null;
  creadoAt: Date;
}

const SELECT_REV = `SELECT r.id, r.beneficio_id, s.radicado, p.nombre_completo AS pcd_nombre, s.id AS solicitud_id, s.correo,
       r.causal_id, c.nombre AS causal, r.descripcion, r.estado, r.resultado, r.traslado_at, r.vence_descargos_at,
       r.descargos_at, r.sin_descargos, r.decidida_at, u.usuario AS iniciada_por, r.created_at
  FROM revocatorias r
  JOIN beneficios b ON b.id = r.beneficio_id
  JOIN solicitudes s ON s.id = b.solicitud_id
  JOIN personas p ON p.id = s.pcd_id
  JOIN catalogo_items c ON c.id = r.causal_id
  JOIN usuarios u ON u.id = r.iniciada_por`;

interface FilaRev {
  id: string;
  beneficio_id: string;
  radicado: string;
  pcd_nombre: string;
  solicitud_id: number;
  correo: string;
  causal_id: number;
  causal: string;
  descripcion: string;
  estado: EstadoRevocatoria;
  resultado: 'REVOCADA' | 'ARCHIVADA' | null;
  traslado_at: Date | null;
  vence_descargos_at: Date | null;
  descargos_at: Date | null;
  sin_descargos: boolean;
  decidida_at: Date | null;
  iniciada_por: string;
  created_at: Date;
}

const mapearRev = (f: FilaRev): Revocatoria => ({
  id: Number(f.id),
  beneficioId: Number(f.beneficio_id),
  radicado: f.radicado,
  pcdNombre: f.pcd_nombre,
  solicitudId: f.solicitud_id,
  correo: f.correo,
  causalId: f.causal_id,
  causal: f.causal,
  descripcion: f.descripcion,
  estado: f.estado,
  resultado: f.resultado,
  trasladoAt: f.traslado_at,
  venceDescargosAt: f.vence_descargos_at,
  descargosAt: f.descargos_at,
  sinDescargos: f.sin_descargos,
  decididaAt: f.decidida_at,
  iniciadaPor: f.iniciada_por,
  creadaAt: f.created_at,
});

export const revocatoriasRepo = {
  async porId(db: Queryable, id: number, bloquear = false): Promise<Revocatoria | null> {
    const r = await db.query<FilaRev>(
      `${SELECT_REV} WHERE r.id = $1 ${bloquear ? 'FOR UPDATE OF r' : ''}`,
      [id],
    );
    return r.rows[0] ? mapearRev(r.rows[0]) : null;
  },

  async listar(
    db: Queryable,
    f: { estado?: EstadoRevocatoria; abiertas?: boolean; limit: number; offset: number },
  ): Promise<{ items: Revocatoria[]; total: number }> {
    const params: unknown[] = [];
    const where = ['true'];
    if (f.estado) {
      params.push(f.estado);
      where.push(`r.estado = $${params.length}`);
    }
    if (f.abiertas) where.push(`r.estado <> 'DECIDIDA'`);
    params.push(f.limit, f.offset);
    const r = await db.query<FilaRev & { total: number }>(
      `${SELECT_REV.replace('SELECT r.id,', 'SELECT COUNT(*) OVER()::int AS total, r.id,')}
        WHERE ${where.join(' AND ')} ORDER BY (r.estado = 'DECIDIDA'), r.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: r.rows.map(mapearRev), total: r.rows[0]?.total ?? 0 };
  },

  async crear(
    db: Queryable,
    d: {
      beneficioId: number;
      causalId: number;
      descripcion: string;
      usuarioId: number;
      origenAlertaId: number | null;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO revocatorias (beneficio_id, causal_id, descripcion, iniciada_por, origen_alerta_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [d.beneficioId, d.causalId, d.descripcion, d.usuarioId, d.origenAlertaId],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  async evento(
    db: Queryable,
    e: {
      revocatoriaId: number;
      etapa: EtapaRevocatoria;
      texto: string;
      fecha: string;
      referencia?: string | null;
      evidencia?: EvidenciaGuardada | null;
      /** Null cuando los descargos los presenta la persona desde el portal. */
      usuarioId: number | null;
      correoId?: number | null;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO revocatoria_eventos (revocatoria_id, etapa, texto, fecha, referencia, evidencia_ruta,
                                        evidencia_nombre, evidencia_mime, evidencia_tamano, evidencia_sha256,
                                        usuario_id, correo_id, origen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [
        e.revocatoriaId,
        e.etapa,
        e.texto,
        e.fecha,
        e.referencia ?? null,
        e.evidencia?.ruta ?? null,
        e.evidencia?.nombre ?? null,
        e.evidencia?.mime ?? null,
        e.evidencia?.tamanoBytes ?? null,
        e.evidencia?.sha256 ?? null,
        e.usuarioId,
        e.correoId ?? null,
        e.usuarioId === null ? 'CIUDADANO' : 'FUNCIONARIO',
      ],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  async eventos(db: Queryable, revocatoriaId: number): Promise<EventoRevocatoria[]> {
    const r = await db.query<{
      id: string;
      etapa: EtapaRevocatoria;
      texto: string;
      fecha: string;
      referencia: string | null;
      evidencia_nombre: string | null;
      evidencia_tamano: number | null;
      usuario: string;
      correo_id: string | null;
      created_at: Date;
    }>(
      `SELECT e.id, e.etapa, e.texto, to_char(e.fecha, 'YYYY-MM-DD') AS fecha, e.referencia, e.evidencia_nombre,
              e.evidencia_tamano, COALESCE(u.usuario, 'Persona beneficiaria') AS usuario, e.correo_id, e.created_at
         FROM revocatoria_eventos e LEFT JOIN usuarios u ON u.id = e.usuario_id
        WHERE e.revocatoria_id = $1 ORDER BY e.created_at, e.id`,
      [revocatoriaId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      etapa: x.etapa,
      texto: x.texto,
      fecha: x.fecha,
      referencia: x.referencia,
      evidencia: x.evidencia_nombre
        ? { nombre: x.evidencia_nombre, tamanoBytes: x.evidencia_tamano as number }
        : null,
      usuario: x.usuario,
      correoId: x.correo_id === null ? null : Number(x.correo_id),
      creadoAt: x.created_at,
    }));
  },

  async evidenciaDeEvento(db: Queryable, id: number): Promise<EvidenciaGuardada | null> {
    const r = await db.query<{
      evidencia_ruta: string | null;
      evidencia_nombre: string;
      evidencia_mime: string;
      evidencia_tamano: number;
      evidencia_sha256: string;
    }>(
      `SELECT evidencia_ruta, evidencia_nombre, evidencia_mime, evidencia_tamano, evidencia_sha256
         FROM revocatoria_eventos WHERE id = $1`,
      [id],
    );
    const f = r.rows[0];
    return f?.evidencia_ruta
      ? {
          ruta: f.evidencia_ruta,
          nombre: f.evidencia_nombre,
          mime: f.evidencia_mime,
          tamanoBytes: f.evidencia_tamano,
          sha256: f.evidencia_sha256,
        }
      : null;
  },

  async fijarTraslado(db: Queryable, id: number, venceDescargos: Date): Promise<void> {
    await db.query(
      `UPDATE revocatorias SET estado = 'EN_TRASLADO', traslado_at = now(), vence_descargos_at = $2, updated_at = now() WHERE id = $1`,
      [id, venceDescargos],
    );
  },

  async fijarDescargos(db: Queryable, id: number): Promise<void> {
    await db.query(
      `UPDATE revocatorias SET estado = 'CON_DESCARGOS', descargos_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  },

  async fijarSinDescargos(db: Queryable, id: number): Promise<void> {
    await db.query(
      `UPDATE revocatorias SET sin_descargos = true, updated_at = now() WHERE id = $1`,
      [id],
    );
  },

  async decidir(db: Queryable, id: number, resultado: 'REVOCADA' | 'ARCHIVADA'): Promise<void> {
    await db.query(
      `UPDATE revocatorias SET estado = 'DECIDIDA', resultado = $2, decidida_at = now(), updated_at = now() WHERE id = $1`,
      [id, resultado],
    );
  },

  /** Revocatorias en curso con el momento desde el que corre el plazo para decidir. */
  /** La revocatoria sin decidir de una solicitud, si la hay. */
  async abiertaDeSolicitud(db: Queryable, solicitudId: number): Promise<Revocatoria | null> {
    const r = await db.query<{ id: string }>(
      `SELECT r.id FROM revocatorias r JOIN beneficios b ON b.id = r.beneficio_id
        WHERE b.solicitud_id = $1 AND r.estado <> 'DECIDIDA' ORDER BY r.id DESC LIMIT 1`,
      [solicitudId],
    );
    return r.rows[0] ? this.porId(db, Number(r.rows[0].id)) : null;
  },

  async enCurso(db: Queryable): Promise<
    {
      id: number;
      radicado: string;
      estado: EstadoRevocatoria;
      sinDescargos: boolean;
      venceDescargosAt: Date | null;
      baseDecision: Date | null;
    }[]
  > {
    const r = await db.query<{
      id: string;
      radicado: string;
      estado: EstadoRevocatoria;
      sin_descargos: boolean;
      vence_descargos_at: Date | null;
      base: Date | null;
    }>(
      `SELECT r.id, s.radicado, r.estado, r.sin_descargos, r.vence_descargos_at,
              CASE WHEN r.estado = 'CON_DESCARGOS' THEN r.descargos_at
                   WHEN r.estado = 'EN_TRASLADO' THEN r.vence_descargos_at END AS base
         FROM revocatorias r JOIN beneficios b ON b.id = r.beneficio_id JOIN solicitudes s ON s.id = b.solicitud_id
        WHERE r.estado IN ('EN_TRASLADO', 'CON_DESCARGOS')`,
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      radicado: x.radicado,
      estado: x.estado,
      sinDescargos: x.sin_descargos,
      venceDescargosAt: x.vence_descargos_at,
      baseDecision: x.base,
    }));
  },
};

// ---------------------------------------------------------------------------------------------------------
// Alertas de los cruces periódicos
// ---------------------------------------------------------------------------------------------------------

export type EstadoAlertaCruce = 'PENDIENTE' | 'DESCARTADA' | 'EN_TRAMITE';

export interface AlertaCruce {
  id: number;
  cargaId: number;
  estructura: string;
  beneficioId: number;
  radicado: string;
  pcdNombre: string;
  causalCodigo: string | null;
  detalle: string;
  estado: EstadoAlertaCruce;
  analizadaPor: string | null;
  analizadaAt: Date | null;
  observacion: string | null;
  revocatoriaId: number | null;
  creadaAt: Date;
}

export const alertasCruceRepo = {
  async crear(
    db: Queryable,
    a: {
      cargaId: number;
      estructuraId: number;
      beneficioId: number;
      causalCodigo: string | null;
      detalle: string;
    },
  ): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO cruce_alertas (carga_id, estructura_id, beneficio_id, causal_codigo, detalle)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (carga_id, beneficio_id) DO NOTHING`,
      [a.cargaId, a.estructuraId, a.beneficioId, a.causalCodigo, a.detalle],
    );
    return r.rowCount === 1;
  },

  async listar(
    db: Queryable,
    f: { estado?: EstadoAlertaCruce; limit: number; offset: number },
  ): Promise<{ items: AlertaCruce[]; total: number }> {
    const params: unknown[] = [];
    const where = ['true'];
    if (f.estado) {
      params.push(f.estado);
      where.push(`a.estado = $${params.length}`);
    }
    params.push(f.limit, f.offset);
    const r = await db.query<{
      id: string;
      carga_id: string;
      estructura: string;
      beneficio_id: string;
      radicado: string;
      pcd_nombre: string;
      causal_codigo: string | null;
      detalle: string;
      estado: EstadoAlertaCruce;
      analizada_por: string | null;
      analizada_at: Date | null;
      observacion: string | null;
      revocatoria_id: string | null;
      creada_at: Date;
      total: number;
    }>(
      `SELECT a.id, a.carga_id, e.nombre AS estructura, a.beneficio_id, s.radicado, p.nombre_completo AS pcd_nombre,
              a.causal_codigo, a.detalle, a.estado, u.usuario AS analizada_por, a.analizada_at, a.observacion,
              a.revocatoria_id, a.creada_at, COUNT(*) OVER()::int AS total
         FROM cruce_alertas a
         JOIN cruce_estructuras e ON e.id = a.estructura_id
         JOIN beneficios b ON b.id = a.beneficio_id
         JOIN solicitudes s ON s.id = b.solicitud_id
         JOIN personas p ON p.id = s.pcd_id
         LEFT JOIN usuarios u ON u.id = a.analizada_por
        WHERE ${where.join(' AND ')}
        ORDER BY (a.estado = 'PENDIENTE') DESC, a.creada_at DESC, a.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      items: r.rows.map((x) => ({
        id: Number(x.id),
        cargaId: Number(x.carga_id),
        estructura: x.estructura,
        beneficioId: Number(x.beneficio_id),
        radicado: x.radicado,
        pcdNombre: x.pcd_nombre,
        causalCodigo: x.causal_codigo,
        detalle: x.detalle,
        estado: x.estado,
        analizadaPor: x.analizada_por,
        analizadaAt: x.analizada_at,
        observacion: x.observacion,
        revocatoriaId: x.revocatoria_id === null ? null : Number(x.revocatoria_id),
        creadaAt: x.creada_at,
      })),
      total: r.rows[0]?.total ?? 0,
    };
  },

  async porId(
    db: Queryable,
    id: number,
    bloquear = false,
  ): Promise<{
    id: number;
    beneficioId: number;
    estado: EstadoAlertaCruce;
    causalCodigo: string | null;
    detalle: string;
  } | null> {
    const r = await db.query<{
      id: string;
      beneficio_id: string;
      estado: EstadoAlertaCruce;
      causal_codigo: string | null;
      detalle: string;
    }>(
      `SELECT id, beneficio_id, estado, causal_codigo, detalle FROM cruce_alertas WHERE id = $1 ${bloquear ? 'FOR UPDATE' : ''}`,
      [id],
    );
    const f = r.rows[0];
    return f
      ? {
          id: Number(f.id),
          beneficioId: Number(f.beneficio_id),
          estado: f.estado,
          causalCodigo: f.causal_codigo,
          detalle: f.detalle,
        }
      : null;
  },

  async analizar(
    db: Queryable,
    id: number,
    a: {
      estado: 'DESCARTADA' | 'EN_TRAMITE';
      usuarioId: number;
      observacion: string;
      revocatoriaId: number | null;
    },
  ): Promise<void> {
    await db.query(
      `UPDATE cruce_alertas SET estado = $2, analizada_por = $3, analizada_at = now(), observacion = $4, revocatoria_id = $5
        WHERE id = $1`,
      [id, a.estado, a.usuarioId, a.observacion, a.revocatoriaId],
    );
  },

  /** Personas de los beneficios vigentes, para compararlas con un archivo de cruce. */
  async personasDeBeneficios(
    db: Queryable,
    soloActivosDesde: Date | null,
  ): Promise<
    {
      beneficioId: number;
      rol: 'PCD' | 'CUIDADOR';
      numero: string;
      radicado: string;
      estado: EstadoBeneficio;
    }[]
  > {
    const r = await db.query<{
      beneficio_id: string;
      rol: 'PCD' | 'CUIDADOR';
      numero: string;
      radicado: string;
      estado: EstadoBeneficio;
    }>(
      `SELECT b.id AS beneficio_id, bp.rol, p.numero_identificacion AS numero, s.radicado, b.estado
         FROM beneficios b
         JOIN beneficio_personas bp ON bp.beneficio_id = b.id AND bp.vigente
         JOIN personas p ON p.id = bp.persona_id
         JOIN solicitudes s ON s.id = b.solicitud_id
        WHERE b.estado <> 'FINALIZADO'
          AND ($1::timestamptz IS NULL OR (b.estado = 'ACTIVO' AND b.activado_at <= $1))`,
      [soloActivosDesde],
    );
    return r.rows.map((x) => ({
      beneficioId: Number(x.beneficio_id),
      rol: x.rol,
      numero: x.numero,
      radicado: x.radicado,
      estado: x.estado,
    }));
  },

  /** De esas huellas, las que aparecen en la carga, con su detalle. */
  async enCarga(db: Queryable, cargaId: number, huellas: string[]): Promise<Map<string, string>> {
    if (huellas.length === 0) return new Map();
    const r = await db.query<{ identificacion_huella: string; detalle: string }>(
      `SELECT identificacion_huella, detalle FROM cruce_registros
        WHERE carga_id = $1 AND identificacion_huella = ANY($2::text[])`,
      [cargaId, huellas],
    );
    return new Map(r.rows.map((x) => [x.identificacion_huella, x.detalle]));
  },
};
