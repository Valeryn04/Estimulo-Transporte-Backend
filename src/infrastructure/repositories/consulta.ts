import type { EstadoSolicitud } from '../../domain/estados.js';
import type { Queryable } from '../db/pool.js';

export interface SolicitudConsulta {
  id: number;
  correo: string;
  estado: EstadoSolicitud;
  correoVerificadoAt: Date | null;
  pcdNombre: string;
}

export interface DetalleSolicitud extends SolicitudConsulta {
  anio: number;
  createdAt: Date;
  radicado: string | null;
  radicadaAt: Date | null;
}

export interface ComunicacionFila {
  id: number;
  tipo: string;
  asunto: string;
  creadoAt: Date;
  estado: string;
}

export const consultaRepo = {
  /** Solicitud más reciente de la persona con discapacidad que tiene ese tipo y número de identificación. */
  async ultimaDePcd(
    db: Queryable,
    tipoId: number,
    numero: string,
  ): Promise<SolicitudConsulta | null> {
    const r = await db.query<{
      id: number;
      correo: string;
      estado: EstadoSolicitud;
      correo_verificado_at: Date | null;
      pcd_nombre: string;
    }>(
      `SELECT s.id, s.correo, s.estado, s.correo_verificado_at, p.nombre_completo AS pcd_nombre
         FROM solicitudes s
         JOIN personas p ON p.id = s.pcd_id
         JOIN vigencias v ON v.id = s.vigencia_id
        WHERE p.tipo_identificacion_id = $1 AND p.numero_identificacion = $2
        ORDER BY v.anio DESC LIMIT 1`,
      [tipoId, numero],
    );
    const f = r.rows[0];
    return f
      ? {
          id: f.id,
          correo: f.correo,
          estado: f.estado,
          correoVerificadoAt: f.correo_verificado_at,
          pcdNombre: f.pcd_nombre,
        }
      : null;
  },

  /** Solicitud con ese número de radicado. */
  async porRadicado(db: Queryable, radicado: string): Promise<SolicitudConsulta | null> {
    const r = await db.query<{
      id: number;
      correo: string;
      estado: EstadoSolicitud;
      correo_verificado_at: Date | null;
      pcd_nombre: string;
    }>(
      `SELECT s.id, s.correo, s.estado, s.correo_verificado_at, p.nombre_completo AS pcd_nombre
         FROM solicitudes s JOIN personas p ON p.id = s.pcd_id
        WHERE s.radicado = $1`,
      [radicado],
    );
    const f = r.rows[0];
    return f
      ? {
          id: f.id,
          correo: f.correo,
          estado: f.estado,
          correoVerificadoAt: f.correo_verificado_at,
          pcdNombre: f.pcd_nombre,
        }
      : null;
  },

  async detalle(db: Queryable, solicitudId: number): Promise<DetalleSolicitud | null> {
    const r = await db.query<{
      id: number;
      correo: string;
      estado: EstadoSolicitud;
      correo_verificado_at: Date | null;
      pcd_nombre: string;
      anio: number;
      created_at: Date;
      radicado: string | null;
      radicada_at: Date | null;
    }>(
      `SELECT s.id, s.correo, s.estado, s.correo_verificado_at, p.nombre_completo AS pcd_nombre,
              v.anio, s.created_at, s.radicado, s.radicada_at
         FROM solicitudes s
         JOIN personas p ON p.id = s.pcd_id
         JOIN vigencias v ON v.id = s.vigencia_id
        WHERE s.id = $1`,
      [solicitudId],
    );
    const f = r.rows[0];
    return f
      ? {
          id: f.id,
          correo: f.correo,
          estado: f.estado,
          correoVerificadoAt: f.correo_verificado_at,
          pcdNombre: f.pcd_nombre,
          anio: f.anio,
          createdAt: f.created_at,
          radicado: f.radicado,
          radicadaAt: f.radicada_at,
        }
      : null;
  },

  /** Comunicaciones enviadas al ciudadano. El código de consulta no se lista: es un secreto de un solo uso. */
  async comunicaciones(db: Queryable, solicitudId: number): Promise<ComunicacionFila[]> {
    const r = await db.query<{
      id: number;
      tipo: string;
      asunto: string;
      created_at: Date;
      estado: string;
    }>(
      `SELECT id, tipo, asunto, created_at, estado FROM correos
        WHERE solicitud_id = $1 AND tipo <> 'CODIGO_CONSULTA'
        ORDER BY created_at DESC, id DESC`,
      [solicitudId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      tipo: x.tipo,
      asunto: x.asunto,
      creadoAt: x.created_at,
      estado: x.estado,
    }));
  },
};

export interface CodigoFila {
  id: number;
  codigoHash: string;
  expiraAt: Date;
  intentos: number;
}

export const codigosRepo = {
  async crear(
    db: Queryable,
    d: { solicitudId: number; codigoHash: string; creadoAt: Date; expiraAt: Date },
  ): Promise<void> {
    // Un código nuevo anula los anteriores sin usar.
    await db.query(
      `UPDATE codigos_consulta SET usado_at = $2 WHERE solicitud_id = $1 AND usado_at IS NULL`,
      [d.solicitudId, d.creadoAt],
    );
    await db.query(
      `INSERT INTO codigos_consulta (solicitud_id, codigo_hash, created_at, expira_at)
       VALUES ($1, $2, $3, $4)`,
      [d.solicitudId, d.codigoHash, d.creadoAt, d.expiraAt],
    );
  },

  /** Último código sin usar (puede estar vencido: lo decide el servicio con el reloj de la aplicación). */
  async ultimoSinUsar(db: Queryable, solicitudId: number): Promise<CodigoFila | null> {
    const r = await db.query<{
      id: number;
      codigo_hash: string;
      expira_at: Date;
      intentos: number;
    }>(
      `SELECT id, codigo_hash, expira_at, intentos FROM codigos_consulta
        WHERE solicitud_id = $1 AND usado_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
      [solicitudId],
    );
    const f = r.rows[0];
    return f
      ? { id: f.id, codigoHash: f.codigo_hash, expiraAt: f.expira_at, intentos: f.intentos }
      : null;
  },

  async sumarIntento(db: Queryable, id: number): Promise<void> {
    await db.query(`UPDATE codigos_consulta SET intentos = intentos + 1 WHERE id = $1`, [id]);
  },

  async marcarUsado(db: Queryable, id: number, cuando: Date): Promise<void> {
    await db.query(`UPDATE codigos_consulta SET usado_at = $2 WHERE id = $1`, [id, cuando]);
  },

  /** Último código pedido y cuántos se pidieron en la última hora (control de frecuencia). */
  async resumen(
    db: Queryable,
    solicitudId: number,
    desde: Date,
  ): Promise<{ ultimoAt: Date | null; ultimaHora: number }> {
    const r = await db.query<{ ultimo: Date | null; n: number }>(
      `SELECT MAX(created_at) AS ultimo, COUNT(*) FILTER (WHERE created_at >= $2)::int AS n
         FROM codigos_consulta WHERE solicitud_id = $1`,
      [solicitudId, desde],
    );
    return { ultimoAt: r.rows[0]?.ultimo ?? null, ultimaHora: r.rows[0]?.n ?? 0 };
  },
};
