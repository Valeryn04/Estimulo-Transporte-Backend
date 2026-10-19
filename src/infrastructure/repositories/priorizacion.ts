import {
  ESTADOS_PRIORIZABLES,
  type AporteVariable,
  type DefinicionMatriz,
  type OrigenVariable,
  type VariableMatriz,
} from '../../domain/priorizacion.js';
import type { Queryable } from '../db/pool.js';

export type EstadoMatriz = 'BORRADOR' | 'EN_APROBACION' | 'VIGENTE' | 'ARCHIVADA' | 'RECHAZADA';

export interface Matriz extends DefinicionMatriz {
  id: number;
  version: number;
  estado: EstadoMatriz;
  creadaPor: string | null;
  creadaAt: Date;
  solicitadaPor: string | null;
  solicitadaPorId: number | null;
  solicitadaAt: Date | null;
  decididaPor: string | null;
  decididaAt: Date | null;
  motivoDecision: string | null;
  vigenteDesde: Date | null;
  vigenteHasta: Date | null;
}

interface FilaMatriz {
  id: number;
  version: number;
  estado: EstadoMatriz;
  notas: string;
  desempate: string[];
  creada_por: string | null;
  creada_at: Date;
  solicitada_por: string | null;
  solicitada_por_id: number | null;
  solicitada_at: Date | null;
  decidida_por: string | null;
  decidida_at: Date | null;
  motivo_decision: string | null;
  vigente_desde: Date | null;
  vigente_hasta: Date | null;
}

const SELECT_MATRIZ = `SELECT m.id, m.version, m.estado, m.notas, m.desempate, uc.usuario AS creada_por, m.creada_at,
                              us.usuario AS solicitada_por, m.solicitada_por AS solicitada_por_id, m.solicitada_at, ud.usuario AS decidida_por, m.decidida_at,
                              m.motivo_decision, m.vigente_desde, m.vigente_hasta
                         FROM matrices m
                         LEFT JOIN usuarios uc ON uc.id = m.creada_por
                         LEFT JOIN usuarios us ON us.id = m.solicitada_por
                         LEFT JOIN usuarios ud ON ud.id = m.decidida_por`;

const mapearMatriz = (f: FilaMatriz, variables: VariableMatriz[]): Matriz => ({
  id: f.id,
  version: f.version,
  estado: f.estado,
  notas: f.notas,
  desempate: f.desempate,
  creadaPor: f.creada_por,
  creadaAt: f.creada_at,
  solicitadaPor: f.solicitada_por,
  solicitadaPorId: f.solicitada_por_id,
  solicitadaAt: f.solicitada_at,
  decididaPor: f.decidida_por,
  decididaAt: f.decidida_at,
  motivoDecision: f.motivo_decision,
  vigenteDesde: f.vigente_desde,
  vigenteHasta: f.vigente_hasta,
  variables,
});

async function variablesDe(db: Queryable, matrizId: number): Promise<VariableMatriz[]> {
  const v = await db.query<{
    id: number;
    codigo: string;
    nombre: string;
    descripcion: string;
    origen: OrigenVariable;
    peso: string;
  }>(
    `SELECT id, codigo, nombre, descripcion, origen, peso FROM matriz_variables
      WHERE matriz_id = $1 ORDER BY posicion, id`,
    [matrizId],
  );
  const o = await db.query<{
    variable_id: number;
    codigo: string;
    etiqueta: string;
    puntos: string;
  }>(
    `SELECT o.variable_id, o.codigo, o.etiqueta, o.puntos
       FROM matriz_opciones o JOIN matriz_variables mv ON mv.id = o.variable_id
      WHERE mv.matriz_id = $1 ORDER BY o.posicion, o.id`,
    [matrizId],
  );
  return v.rows.map((x) => ({
    codigo: x.codigo,
    nombre: x.nombre,
    descripcion: x.descripcion,
    origen: x.origen,
    peso: Number(x.peso),
    opciones: o.rows
      .filter((y) => y.variable_id === x.id)
      .map((y) => ({ codigo: y.codigo, etiqueta: y.etiqueta, puntos: Number(y.puntos) })),
  }));
}

async function escribirVariables(
  db: Queryable,
  matrizId: number,
  variables: readonly VariableMatriz[],
): Promise<void> {
  await db.query(
    `DELETE FROM matriz_opciones WHERE variable_id IN (SELECT id FROM matriz_variables WHERE matriz_id = $1)`,
    [matrizId],
  );
  await db.query(`DELETE FROM matriz_variables WHERE matriz_id = $1`, [matrizId]);
  for (const [i, v] of variables.entries()) {
    const r = await db.query<{ id: number }>(
      `INSERT INTO matriz_variables (matriz_id, codigo, nombre, descripcion, origen, peso, posicion)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [matrizId, v.codigo, v.nombre, v.descripcion, v.origen, v.peso, i],
    );
    const variableId = (r.rows[0] as { id: number }).id;
    for (const [j, o] of v.opciones.entries()) {
      await db.query(
        `INSERT INTO matriz_opciones (variable_id, codigo, etiqueta, puntos, posicion)
         VALUES ($1, $2, $3, $4, $5)`,
        [variableId, o.codigo, o.etiqueta, o.puntos, j],
      );
    }
  }
}

export const matricesRepo = {
  async listar(db: Queryable): Promise<Omit<Matriz, 'variables'>[]> {
    const r = await db.query<FilaMatriz>(`${SELECT_MATRIZ} ORDER BY m.version DESC`);
    return r.rows.map((f) => {
      const { variables: _omitidas, ...resto } = mapearMatriz(f, []);
      void _omitidas;
      return resto;
    });
  },

  async porId(db: Queryable, id: number): Promise<Matriz | null> {
    const r = await db.query<FilaMatriz>(`${SELECT_MATRIZ} WHERE m.id = $1`, [id]);
    return r.rows[0] ? mapearMatriz(r.rows[0], await variablesDe(db, id)) : null;
  },

  async vigente(db: Queryable): Promise<Matriz | null> {
    const r = await db.query<FilaMatriz>(`${SELECT_MATRIZ} WHERE m.estado = 'VIGENTE'`);
    return r.rows[0] ? mapearMatriz(r.rows[0], await variablesDe(db, r.rows[0].id)) : null;
  },

  async abierta(
    db: Queryable,
  ): Promise<{ id: number; version: number; estado: EstadoMatriz } | null> {
    const r = await db.query<{ id: number; version: number; estado: EstadoMatriz }>(
      `SELECT id, version, estado FROM matrices WHERE estado IN ('BORRADOR', 'EN_APROBACION')`,
    );
    return r.rows[0] ?? null;
  },

  async crearBorrador(db: Queryable, usuarioId: number, d: DefinicionMatriz): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO matrices (version, estado, notas, desempate, creada_por)
       VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM matrices), 'BORRADOR', $1, $2, $3) RETURNING id`,
      [d.notas, d.desempate, usuarioId],
    );
    const id = (r.rows[0] as { id: number }).id;
    await escribirVariables(db, id, d.variables);
    return id;
  },

  async reemplazar(db: Queryable, id: number, d: DefinicionMatriz): Promise<void> {
    await db.query(`UPDATE matrices SET notas = $2, desempate = $3 WHERE id = $1`, [
      id,
      d.notas,
      d.desempate,
    ]);
    await escribirVariables(db, id, d.variables);
  },

  async solicitarAprobacion(db: Queryable, id: number, usuarioId: number): Promise<void> {
    await db.query(
      `UPDATE matrices SET estado = 'EN_APROBACION', solicitada_por = $2, solicitada_at = now() WHERE id = $1`,
      [id, usuarioId],
    );
  },

  async volverABorrador(db: Queryable, id: number): Promise<void> {
    await db.query(
      `UPDATE matrices SET estado = 'BORRADOR', solicitada_por = NULL, solicitada_at = NULL WHERE id = $1`,
      [id],
    );
  },

  /** La versión aprobada queda vigente y la anterior se archiva. */
  async activar(db: Queryable, id: number, usuarioId: number, motivo: string): Promise<void> {
    await db.query(
      `UPDATE matrices SET estado = 'ARCHIVADA', vigente_hasta = now() WHERE estado = 'VIGENTE'`,
    );
    await db.query(
      `UPDATE matrices SET estado = 'VIGENTE', decidida_por = $2, decidida_at = now(), motivo_decision = $3,
              vigente_desde = now() WHERE id = $1`,
      [id, usuarioId, motivo],
    );
  },

  async rechazar(db: Queryable, id: number, usuarioId: number, motivo: string): Promise<void> {
    await db.query(
      `UPDATE matrices SET estado = 'RECHAZADA', decidida_por = $2, decidida_at = now(), motivo_decision = $3 WHERE id = $1`,
      [id, usuarioId, motivo],
    );
  },
};

// ---------------------------------------------------------------------------------------------------------
// Datos que el validador registra para la priorización
// ---------------------------------------------------------------------------------------------------------

export const variablesCasoRepo = {
  async valores(db: Queryable, solicitudId: number): Promise<Record<string, string>> {
    const r = await db.query<{ variable: string; valor: string }>(
      `SELECT variable, valor FROM validacion_variables WHERE solicitud_id = $1`,
      [solicitudId],
    );
    return Object.fromEntries(r.rows.map((f) => [f.variable, f.valor]));
  },

  async guardar(
    db: Queryable,
    solicitudId: number,
    variable: string,
    valor: string,
    usuarioId: number,
  ): Promise<void> {
    await db.query(
      `INSERT INTO validacion_variables (solicitud_id, variable, valor, registrado_por)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (solicitud_id, variable)
       DO UPDATE SET valor = EXCLUDED.valor, registrado_por = EXCLUDED.registrado_por, registrado_at = now()`,
      [solicitudId, variable, valor, usuarioId],
    );
  },
};

// ---------------------------------------------------------------------------------------------------------
// Cálculos y listado
// ---------------------------------------------------------------------------------------------------------

export interface Calculo {
  id: number;
  solicitudId: number;
  matrizId: number;
  matrizVersion: number;
  puntaje: number;
  detalle: AporteVariable[];
  vigente: boolean;
  calculadoPor: string | null;
  calculadoAt: Date;
}

interface FilaCalculo {
  id: string;
  solicitud_id: number;
  matriz_id: number;
  matriz_version: number;
  puntaje: string;
  detalle: AporteVariable[];
  vigente: boolean;
  calculado_por: string | null;
  calculado_at: Date;
}

const mapearCalculo = (f: FilaCalculo): Calculo => ({
  id: Number(f.id),
  solicitudId: f.solicitud_id,
  matrizId: f.matriz_id,
  matrizVersion: f.matriz_version,
  puntaje: Number(f.puntaje),
  detalle: f.detalle,
  vigente: f.vigente,
  calculadoPor: f.calculado_por,
  calculadoAt: f.calculado_at,
});

const SELECT_CALCULO = `SELECT p.id, p.solicitud_id, p.matriz_id, m.version AS matriz_version, p.puntaje, p.detalle,
                               p.vigente, u.usuario AS calculado_por, p.calculado_at
                          FROM priorizaciones p JOIN matrices m ON m.id = p.matriz_id
                          LEFT JOIN usuarios u ON u.id = p.calculado_por`;

export interface Candidato {
  solicitudId: number;
  radicado: string;
  radicadaAt: Date;
  estado: string;
  pcdNombre: string;
  matrizId: number | null;
  puntajeActual: number | null;
  aportesActuales: Record<string, number> | null;
}

export interface FiltroListado {
  vigenciaId?: number;
  localidadId?: number;
  transporteId?: number;
  poblacion?: 'CON_CUIDADOR' | 'SIN_CUIDADOR';
  q?: string;
}

export interface FilaListado {
  solicitudId: number;
  radicado: string;
  radicadaAt: Date;
  estado: string;
  pcdNombre: string;
  localidad: string | null;
  transporte: string | null;
  conCuidador: boolean | null;
  calculoId: number;
  matrizVersion: number;
  puntaje: number;
  aportes: Record<string, number>;
  calculadoAt: Date;
  ajuste: number;
  excepcionId: number | null;
  excepcionPendienteId: number | null;
}

const escaparLike = (t: string): string => t.replace(/[\\%_]/g, '\\$&');

export const calculosRepo = {
  async vigenciaActivaId(db: Queryable): Promise<number | null> {
    const r = await db.query<{ id: number }>(`SELECT id FROM vigencias WHERE activa`);
    return r.rows[0]?.id ?? null;
  },

  async vigente(db: Queryable, solicitudId: number): Promise<Calculo | null> {
    const r = await db.query<FilaCalculo>(
      `${SELECT_CALCULO} WHERE p.solicitud_id = $1 AND p.vigente`,
      [solicitudId],
    );
    return r.rows[0] ? mapearCalculo(r.rows[0]) : null;
  },

  async historial(db: Queryable, solicitudId: number): Promise<Calculo[]> {
    const r = await db.query<FilaCalculo>(
      `${SELECT_CALCULO} WHERE p.solicitud_id = $1 ORDER BY p.calculado_at DESC, p.id DESC`,
      [solicitudId],
    );
    return r.rows.map(mapearCalculo);
  },

  /** Guarda el cálculo, deja el anterior como historia y pasa el caso a «Priorizada». */
  async guardar(
    db: Queryable,
    d: {
      solicitudId: number;
      matrizId: number;
      puntaje: number;
      detalle: AporteVariable[];
      usuarioId: number | null;
    },
  ): Promise<number> {
    await db.query(
      `UPDATE priorizaciones SET vigente = false WHERE solicitud_id = $1 AND vigente`,
      [d.solicitudId],
    );
    const r = await db.query<{ id: string }>(
      `INSERT INTO priorizaciones (solicitud_id, matriz_id, puntaje, detalle, calculado_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [d.solicitudId, d.matrizId, d.puntaje, JSON.stringify(d.detalle), d.usuarioId],
    );
    await db.query(
      `UPDATE solicitudes SET estado = 'PRIORIZADA', updated_at = now() WHERE id = $1 AND estado = 'VALIDADA'`,
      [d.solicitudId],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  /** Casos validados de la vigencia, con su cálculo vigente si lo tienen. */
  async candidatos(db: Queryable, vigenciaId: number | null): Promise<Candidato[]> {
    const r = await db.query<{
      id: number;
      radicado: string;
      radicada_at: Date;
      estado: string;
      pcd_nombre: string;
      matriz_id: number | null;
      puntaje: string | null;
      detalle: AporteVariable[] | null;
    }>(
      `SELECT s.id, s.radicado, s.radicada_at, s.estado, p.nombre_completo AS pcd_nombre,
              pr.matriz_id, pr.puntaje, pr.detalle
         FROM solicitudes s
         JOIN personas p ON p.id = s.pcd_id
         LEFT JOIN priorizaciones pr ON pr.solicitud_id = s.id AND pr.vigente
        WHERE s.estado = ANY($1::text[]) AND ($2::int IS NULL OR s.vigencia_id = $2)
        ORDER BY s.radicada_at, s.id`,
      [[...ESTADOS_PRIORIZABLES], vigenciaId],
    );
    return r.rows.map((f) => ({
      solicitudId: f.id,
      radicado: f.radicado,
      radicadaAt: f.radicada_at,
      estado: f.estado,
      pcdNombre: f.pcd_nombre,
      matrizId: f.matriz_id,
      puntajeActual: f.puntaje === null ? null : Number(f.puntaje),
      aportesActuales: f.detalle
        ? Object.fromEntries(f.detalle.map((d) => [d.variable, d.aporte]))
        : null,
    }));
  },

  async listado(db: Queryable, f: FiltroListado): Promise<FilaListado[]> {
    const params: unknown[] = [[...ESTADOS_PRIORIZABLES]];
    const where = ['s.estado = ANY($1::text[])'];
    if (f.vigenciaId) {
      params.push(f.vigenciaId);
      where.push(`s.vigencia_id = $${params.length}`);
    }
    if (f.localidadId) {
      params.push(f.localidadId);
      where.push(`s.localidad_id = $${params.length}`);
    }
    if (f.transporteId) {
      params.push(f.transporteId);
      where.push(`c.tipo_transporte_id = $${params.length}`);
    }
    if (f.poblacion) {
      where.push(
        f.poblacion === 'CON_CUIDADOR'
          ? 'c.requiere_cuidador IS TRUE'
          : 'c.requiere_cuidador IS NOT TRUE',
      );
    }
    if (f.q) {
      params.push(`%${escaparLike(f.q)}%`);
      where.push(
        `(s.radicado ILIKE $${params.length} OR p.nombre_completo ILIKE $${params.length})`,
      );
    }
    const r = await db.query<{
      id: number;
      radicado: string;
      radicada_at: Date;
      estado: string;
      pcd_nombre: string;
      localidad: string | null;
      transporte: string | null;
      requiere_cuidador: boolean | null;
      calculo_id: string;
      matriz_version: number;
      puntaje: string;
      detalle: AporteVariable[];
      calculado_at: Date;
      ajuste: string | null;
      excepcion_id: string | null;
      pendiente_id: string | null;
    }>(
      `SELECT s.id, s.radicado, s.radicada_at, s.estado, p.nombre_completo AS pcd_nombre,
              loc.nombre AS localidad, tr.nombre AS transporte, c.requiere_cuidador,
              pr.id AS calculo_id, m.version AS matriz_version, pr.puntaje, pr.detalle, pr.calculado_at,
              ex.ajuste, ex.id AS excepcion_id, pend.id AS pendiente_id
         FROM solicitudes s
         JOIN personas p ON p.id = s.pcd_id
         JOIN priorizaciones pr ON pr.solicitud_id = s.id AND pr.vigente
         JOIN matrices m ON m.id = pr.matriz_id
         LEFT JOIN catalogo_items loc ON loc.id = s.localidad_id
         LEFT JOIN caracterizaciones c ON c.solicitud_id = s.id
         LEFT JOIN catalogo_items tr ON tr.id = c.tipo_transporte_id
         LEFT JOIN priorizacion_excepciones ex ON ex.priorizacion_id = pr.id AND ex.estado = 'APROBADA'
         LEFT JOIN priorizacion_excepciones pend ON pend.solicitud_id = s.id AND pend.estado = 'PROPUESTA'
        WHERE ${where.join(' AND ')}`,
      params,
    );
    return r.rows.map((x) => ({
      solicitudId: x.id,
      radicado: x.radicado,
      radicadaAt: x.radicada_at,
      estado: x.estado,
      pcdNombre: x.pcd_nombre,
      localidad: x.localidad,
      transporte: x.transporte,
      conCuidador: x.requiere_cuidador,
      calculoId: Number(x.calculo_id),
      matrizVersion: x.matriz_version,
      puntaje: Number(x.puntaje),
      aportes: Object.fromEntries(x.detalle.map((d) => [d.variable, d.aporte])),
      calculadoAt: x.calculado_at,
      ajuste: x.ajuste === null ? 0 : Number(x.ajuste),
      excepcionId: x.excepcion_id === null ? null : Number(x.excepcion_id),
      excepcionPendienteId: x.pendiente_id === null ? null : Number(x.pendiente_id),
    }));
  },
};

// ---------------------------------------------------------------------------------------------------------
// Excepciones
// ---------------------------------------------------------------------------------------------------------

export type EstadoExcepcion = 'PROPUESTA' | 'APROBADA' | 'RECHAZADA';

export interface Excepcion {
  id: number;
  solicitudId: number;
  radicado: string;
  pcdNombre: string;
  priorizacionId: number;
  puntajeOriginal: number;
  ajuste: number;
  justificacion: string;
  evidencia: { nombre: string; mime: string; tamanoBytes: number; sha256: string };
  estado: EstadoExcepcion;
  propuestaPor: string;
  propuestaPorId: number;
  propuestaAt: Date;
  decididaPor: string | null;
  decididaAt: Date | null;
  motivoDecision: string | null;
  /** El cálculo al que se aplica sigue siendo el vigente del caso. */
  aplicable: boolean;
}

interface FilaExcepcion {
  id: string;
  solicitud_id: number;
  radicado: string;
  pcd_nombre: string;
  priorizacion_id: string;
  puntaje: string;
  ajuste: string;
  justificacion: string;
  evidencia_nombre: string;
  evidencia_mime: string;
  evidencia_tamano: number;
  evidencia_sha256: string;
  estado: EstadoExcepcion;
  propuesta_por: string;
  propuesta_por_id: number;
  propuesta_at: Date;
  decidida_por: string | null;
  decidida_at: Date | null;
  motivo_decision: string | null;
  vigente: boolean;
}

const SELECT_EXCEPCION = `SELECT e.id, e.solicitud_id, s.radicado, pe.nombre_completo AS pcd_nombre, e.priorizacion_id, pr.puntaje,
                                 e.ajuste, e.justificacion, e.evidencia_nombre, e.evidencia_mime, e.evidencia_tamano,
                                 e.evidencia_sha256, e.estado, up.usuario AS propuesta_por, e.propuesta_por AS propuesta_por_id,
                                 e.propuesta_at, ud.usuario AS decidida_por, e.decidida_at, e.motivo_decision, pr.vigente
                            FROM priorizacion_excepciones e
                            JOIN solicitudes s ON s.id = e.solicitud_id
                            JOIN personas pe ON pe.id = s.pcd_id
                            JOIN priorizaciones pr ON pr.id = e.priorizacion_id
                            JOIN usuarios up ON up.id = e.propuesta_por
                            LEFT JOIN usuarios ud ON ud.id = e.decidida_por`;

const mapearExcepcion = (f: FilaExcepcion): Excepcion => ({
  id: Number(f.id),
  solicitudId: f.solicitud_id,
  radicado: f.radicado,
  pcdNombre: f.pcd_nombre,
  priorizacionId: Number(f.priorizacion_id),
  puntajeOriginal: Number(f.puntaje),
  ajuste: Number(f.ajuste),
  justificacion: f.justificacion,
  evidencia: {
    nombre: f.evidencia_nombre,
    mime: f.evidencia_mime,
    tamanoBytes: f.evidencia_tamano,
    sha256: f.evidencia_sha256,
  },
  estado: f.estado,
  propuestaPor: f.propuesta_por,
  propuestaPorId: f.propuesta_por_id,
  propuestaAt: f.propuesta_at,
  decididaPor: f.decidida_por,
  decididaAt: f.decidida_at,
  motivoDecision: f.motivo_decision,
  aplicable: f.vigente && f.estado === 'APROBADA',
});

export interface EvidenciaGuardada {
  ruta: string;
  nombre: string;
  mime: string;
  tamanoBytes: number;
  sha256: string;
}

export const excepcionesRepo = {
  async listar(
    db: Queryable,
    f: { estado?: EstadoExcepcion; solicitudId?: number; limit: number; offset: number },
  ): Promise<{ items: Excepcion[]; total: number }> {
    const params: unknown[] = [];
    const where: string[] = ['true'];
    if (f.estado) {
      params.push(f.estado);
      where.push(`e.estado = $${params.length}`);
    }
    if (f.solicitudId) {
      params.push(f.solicitudId);
      where.push(`e.solicitud_id = $${params.length}`);
    }
    params.push(f.limit, f.offset);
    const r = await db.query<FilaExcepcion & { total: number }>(
      `${SELECT_EXCEPCION.replace('SELECT e.id,', 'SELECT COUNT(*) OVER()::int AS total, e.id,')}
        WHERE ${where.join(' AND ')}
        ORDER BY (e.estado = 'PROPUESTA') DESC, e.propuesta_at DESC, e.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { items: r.rows.map(mapearExcepcion), total: r.rows[0]?.total ?? 0 };
  },

  async porId(db: Queryable, id: number): Promise<Excepcion | null> {
    const r = await db.query<FilaExcepcion>(`${SELECT_EXCEPCION} WHERE e.id = $1`, [id]);
    return r.rows[0] ? mapearExcepcion(r.rows[0]) : null;
  },

  async rutaEvidencia(db: Queryable, id: number): Promise<EvidenciaGuardada | null> {
    const r = await db.query<{
      evidencia_ruta: string;
      evidencia_nombre: string;
      evidencia_mime: string;
      evidencia_tamano: number;
      evidencia_sha256: string;
    }>(
      `SELECT evidencia_ruta, evidencia_nombre, evidencia_mime, evidencia_tamano, evidencia_sha256
         FROM priorizacion_excepciones WHERE id = $1`,
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

  async crear(
    db: Queryable,
    d: {
      solicitudId: number;
      priorizacionId: number;
      ajuste: number;
      justificacion: string;
      evidencia: EvidenciaGuardada;
      usuarioId: number;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO priorizacion_excepciones
         (solicitud_id, priorizacion_id, ajuste, justificacion, evidencia_ruta, evidencia_nombre, evidencia_mime,
          evidencia_tamano, evidencia_sha256, propuesta_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        d.solicitudId,
        d.priorizacionId,
        d.ajuste,
        d.justificacion,
        d.evidencia.ruta,
        d.evidencia.nombre,
        d.evidencia.mime,
        d.evidencia.tamanoBytes,
        d.evidencia.sha256,
        d.usuarioId,
      ],
    );
    return Number((r.rows[0] as { id: string }).id);
  },

  async decidir(
    db: Queryable,
    id: number,
    estado: 'APROBADA' | 'RECHAZADA',
    usuarioId: number,
    motivo: string,
  ): Promise<void> {
    await db.query(
      `UPDATE priorizacion_excepciones SET estado = $2, decidida_por = $3, decidida_at = now(), motivo_decision = $4
        WHERE id = $1`,
      [id, estado, usuarioId, motivo],
    );
  },
};
