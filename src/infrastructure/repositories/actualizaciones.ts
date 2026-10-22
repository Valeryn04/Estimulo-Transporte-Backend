import type { Queryable } from '../db/pool.js';
import type { EvidenciaGuardada } from './priorizacion.js';

export type DatoActualizable = 'DIRECCION' | 'CORREO' | 'CUIDADOR';

export interface ActualizacionDatos {
  id: number;
  beneficioId: number;
  dato: DatoActualizable;
  anterior: unknown;
  nuevo: unknown;
  justificacion: string;
  evidencia: { nombre: string; tamanoBytes: number };
  responsable: string;
  creadaAt: Date;
}

export interface SolicitudActualizable {
  direccion: string | null;
  localidad_id: number | null;
  barrio_id: number | null;
  localidad: string | null;
  barrio: string | null;
  correo: string;
  cuidador_id: number | null;
  pcd_id: number;
  vigencia_id: number;
  cuidador_nombre: string | null;
  cuidador_numero: string | null;
  cuidador_tipo: string | null;
}

/** Actualización de datos del beneficiario (RF-BEN-05): cada cambio guarda el valor anterior, el nuevo y su soporte. */
export const actualizacionesRepo = {
  async crear(
    db: Queryable,
    d: {
      beneficioId: number;
      dato: DatoActualizable;
      anterior: unknown;
      nuevo: unknown;
      justificacion: string;
      evidencia: EvidenciaGuardada;
      usuarioId: number;
    },
  ): Promise<number> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO novedades_datos (beneficio_id, dato, valor_anterior, valor_nuevo, justificacion, evidencia_ruta,
                                    evidencia_nombre, evidencia_mime, evidencia_tamano, evidencia_sha256, responsable_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        d.beneficioId,
        d.dato,
        JSON.stringify(d.anterior),
        JSON.stringify(d.nuevo),
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

  async delBeneficio(db: Queryable, beneficioId: number): Promise<ActualizacionDatos[]> {
    const r = await db.query<{
      id: string;
      beneficio_id: string;
      dato: DatoActualizable;
      valor_anterior: unknown;
      valor_nuevo: unknown;
      justificacion: string;
      evidencia_nombre: string;
      evidencia_tamano: number;
      responsable: string;
      created_at: Date;
    }>(
      `SELECT n.id, n.beneficio_id, n.dato, n.valor_anterior, n.valor_nuevo, n.justificacion, n.evidencia_nombre,
              n.evidencia_tamano, u.usuario AS responsable, n.created_at
         FROM novedades_datos n JOIN usuarios u ON u.id = n.responsable_id
        WHERE n.beneficio_id = $1 ORDER BY n.id`,
      [beneficioId],
    );
    return r.rows.map((x) => ({
      id: Number(x.id),
      beneficioId: Number(x.beneficio_id),
      dato: x.dato,
      anterior: x.valor_anterior,
      nuevo: x.valor_nuevo,
      justificacion: x.justificacion,
      evidencia: { nombre: x.evidencia_nombre, tamanoBytes: x.evidencia_tamano },
      responsable: x.responsable,
      creadaAt: x.created_at,
    }));
  },

  async evidencia(db: Queryable, id: number): Promise<EvidenciaGuardada | null> {
    const r = await db.query<{
      evidencia_ruta: string;
      evidencia_nombre: string;
      evidencia_mime: string;
      evidencia_tamano: number;
      evidencia_sha256: string;
    }>(
      `SELECT evidencia_ruta, evidencia_nombre, evidencia_mime, evidencia_tamano, evidencia_sha256
         FROM novedades_datos WHERE id = $1`,
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

  /** Datos actuales de la solicitud que pueden actualizarse; deja la fila bloqueada. */
  async solicitud(db: Queryable, solicitudId: number): Promise<SolicitudActualizable | null> {
    const r = await db.query<SolicitudActualizable>(
      `SELECT s.direccion, s.localidad_id, s.barrio_id, l.nombre AS localidad, b.nombre AS barrio, s.correo,
              s.cuidador_id, s.pcd_id, s.vigencia_id, pc.nombre_completo AS cuidador_nombre,
              pc.numero_identificacion AS cuidador_numero, t.nombre AS cuidador_tipo
         FROM solicitudes s
         LEFT JOIN personas pc ON pc.id = s.cuidador_id
         LEFT JOIN catalogo_items t ON t.id = pc.tipo_identificacion_id
         LEFT JOIN catalogo_items l ON l.id = s.localidad_id
         LEFT JOIN catalogo_items b ON b.id = s.barrio_id
        WHERE s.id = $1 FOR UPDATE OF s`,
      [solicitudId],
    );
    return r.rows[0] ?? null;
  },

  async barrioDeLocalidad(db: Queryable, localidadId: number, barrioId: number): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM catalogo_items b
         JOIN catalogo_items l ON l.id = b.padre_id AND l.catalogo = 'LOCALIDAD' AND l.activo
        WHERE b.id = $1 AND b.catalogo = 'BARRIO' AND b.activo AND l.id = $2`,
      [barrioId, localidadId],
    );
    return (r.rowCount ?? 0) > 0;
  },

  async aplicarDireccion(
    db: Queryable,
    solicitudId: number,
    d: { direccion: string; localidadId: number; barrioId: number },
  ): Promise<void> {
    await db.query(
      `UPDATE solicitudes SET direccion = $2, localidad_id = $3, barrio_id = $4 WHERE id = $1`,
      [solicitudId, d.direccion, d.localidadId, d.barrioId],
    );
  },

  async aplicarCorreo(db: Queryable, solicitudId: number, correo: string): Promise<void> {
    await db.query(`UPDATE solicitudes SET correo = $2 WHERE id = $1`, [solicitudId, correo]);
  },

  /** Cambia el cuidador de la solicitud y del beneficio, y libera la tarjeta del anterior. */
  async cambiarCuidador(
    db: Queryable,
    solicitudId: number,
    beneficioId: number,
    personaId: number,
  ): Promise<void> {
    await db.query(`UPDATE solicitudes SET cuidador_id = $2 WHERE id = $1`, [
      solicitudId,
      personaId,
    ]);
    await db.query(
      `UPDATE beneficio_personas SET persona_id = $2 WHERE beneficio_id = $1 AND rol = 'CUIDADOR'`,
      [beneficioId, personaId],
    );
    await db.query(
      `UPDATE entregas SET vigente = false WHERE beneficio_id = $1 AND rol = 'CUIDADOR' AND vigente`,
      [beneficioId],
    );
  },

  async tieneCuidador(db: Queryable, beneficioId: number): Promise<boolean> {
    const r = await db.query(
      `SELECT 1 FROM beneficio_personas WHERE beneficio_id = $1 AND rol = 'CUIDADOR'`,
      [beneficioId],
    );
    return (r.rowCount ?? 0) > 0;
  },
};
