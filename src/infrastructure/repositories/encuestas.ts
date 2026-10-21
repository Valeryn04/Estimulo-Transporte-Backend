import type { DatosPregunta, PreguntaEncuesta, Respuestas } from '../../domain/encuestas.js';
import type { Queryable } from '../db/pool.js';

export type EstadoEncuesta = 'BORRADOR' | 'PUBLICADA' | 'CERRADA';

export interface Encuesta {
  id: number;
  titulo: string;
  descripcion: string;
  estado: EstadoEncuesta;
  vigenteDesde: string;
  vigenteHasta: string;
  creadaPor: string;
  creadaAt: Date;
  publicadaAt: Date | null;
  cerradaAt: Date | null;
  invitadas: number;
  respondidas: number;
}

interface Fila {
  id: number;
  titulo: string;
  descripcion: string;
  estado: EstadoEncuesta;
  vigente_desde: string;
  vigente_hasta: string;
  usuario: string;
  creada_at: Date;
  publicada_at: Date | null;
  cerrada_at: Date | null;
  invitadas: number;
  respondidas: number;
}

const SELECT = `SELECT e.id, e.titulo, e.descripcion, e.estado, to_char(e.vigente_desde, 'YYYY-MM-DD') AS vigente_desde,
       to_char(e.vigente_hasta, 'YYYY-MM-DD') AS vigente_hasta, u.usuario, e.creada_at, e.publicada_at, e.cerrada_at,
       (SELECT COUNT(*)::int FROM encuesta_invitaciones i WHERE i.encuesta_id = e.id) AS invitadas,
       (SELECT COUNT(*)::int FROM encuesta_invitaciones i WHERE i.encuesta_id = e.id AND i.respondida_at IS NOT NULL) AS respondidas
  FROM encuestas e JOIN usuarios u ON u.id = e.creada_por`;

const mapear = (f: Fila): Encuesta => ({
  id: f.id,
  titulo: f.titulo,
  descripcion: f.descripcion,
  estado: f.estado,
  vigenteDesde: f.vigente_desde,
  vigenteHasta: f.vigente_hasta,
  creadaPor: f.usuario,
  creadaAt: f.creada_at,
  publicadaAt: f.publicada_at,
  cerradaAt: f.cerrada_at,
  invitadas: f.invitadas,
  respondidas: f.respondidas,
});

export const encuestasRepo = {
  async listar(db: Queryable): Promise<Encuesta[]> {
    const r = await db.query<Fila>(`${SELECT} ORDER BY e.creada_at DESC, e.id DESC`);
    return r.rows.map(mapear);
  },

  async porId(db: Queryable, id: number, bloquear = false): Promise<Encuesta | null> {
    const r = await db.query<Fila>(
      `${SELECT} WHERE e.id = $1 ${bloquear ? 'FOR UPDATE OF e' : ''}`,
      [id],
    );
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  async crear(
    db: Queryable,
    d: { titulo: string; descripcion: string; desde: string; hasta: string; usuarioId: number },
  ): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO encuestas (titulo, descripcion, vigente_desde, vigente_hasta, creada_por)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [d.titulo, d.descripcion, d.desde, d.hasta, d.usuarioId],
    );
    return (r.rows[0] as { id: number }).id;
  },

  async actualizar(
    db: Queryable,
    id: number,
    d: { titulo: string; descripcion: string; desde: string; hasta: string },
  ): Promise<void> {
    await db.query(
      `UPDATE encuestas SET titulo = $2, descripcion = $3, vigente_desde = $4, vigente_hasta = $5 WHERE id = $1`,
      [id, d.titulo, d.descripcion, d.desde, d.hasta],
    );
  },

  async fijarEstado(db: Queryable, id: number, estado: EstadoEncuesta): Promise<void> {
    await db.query(
      `UPDATE encuestas SET estado = $2,
              publicada_at = CASE WHEN $2 = 'PUBLICADA' THEN now() ELSE publicada_at END,
              cerrada_at = CASE WHEN $2 = 'CERRADA' THEN now() ELSE cerrada_at END
        WHERE id = $1`,
      [id, estado],
    );
  },

  async preguntas(db: Queryable, encuestaId: number): Promise<PreguntaEncuesta[]> {
    const r = await db.query<{
      id: number;
      tipo: PreguntaEncuesta['tipo'];
      texto: string;
      obligatoria: boolean;
      opciones: string[] | null;
      escala_max: number | null;
    }>(
      `SELECT id, tipo, texto, obligatoria, opciones, escala_max FROM encuesta_preguntas
        WHERE encuesta_id = $1 ORDER BY posicion`,
      [encuestaId],
    );
    return r.rows.map((x) => ({
      id: x.id,
      tipo: x.tipo,
      texto: x.texto,
      obligatoria: x.obligatoria,
      opciones: x.opciones,
      escalaMax: x.escala_max,
    }));
  },

  async reemplazarPreguntas(
    db: Queryable,
    encuestaId: number,
    preguntas: readonly DatosPregunta[],
  ): Promise<void> {
    await db.query(`DELETE FROM encuesta_preguntas WHERE encuesta_id = $1`, [encuestaId]);
    for (const [i, p] of preguntas.entries()) {
      await db.query(
        `INSERT INTO encuesta_preguntas (encuesta_id, posicion, tipo, texto, obligatoria, opciones, escala_max)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          encuestaId,
          i + 1,
          p.tipo,
          p.texto.trim(),
          p.obligatoria,
          p.tipo === 'SELECCION' ? (p.opciones ?? []).map((o) => o.trim()).filter(Boolean) : null,
          p.tipo === 'ESCALA' ? p.escalaMax : null,
        ],
      );
    }
  },

  /** Beneficios activos (con el correo y el nombre de la persona) a quienes se invita. */
  async beneficiosActivos(
    db: Queryable,
  ): Promise<{ beneficioId: number; solicitudId: number; correo: string; nombre: string }[]> {
    const r = await db.query<{ id: string; solicitud_id: number; correo: string; nombre: string }>(
      `SELECT b.id, s.id AS solicitud_id, s.correo, p.nombre_completo AS nombre
         FROM beneficios b JOIN solicitudes s ON s.id = b.solicitud_id JOIN personas p ON p.id = s.pcd_id
        WHERE b.estado = 'ACTIVO' ORDER BY b.id`,
    );
    return r.rows.map((x) => ({
      beneficioId: Number(x.id),
      solicitudId: x.solicitud_id,
      correo: x.correo,
      nombre: x.nombre,
    }));
  },

  async invitar(
    db: Queryable,
    encuestaId: number,
    beneficioId: number,
    tokenHash: string,
  ): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO encuesta_invitaciones (encuesta_id, beneficio_id, token_hash) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [encuestaId, beneficioId, tokenHash],
    );
    return r.rowCount === 1;
  },

  async invitacion(
    db: Queryable,
    tokenHash: string,
    bloquear = false,
  ): Promise<{ encuestaId: number; beneficioId: number; respondida: boolean } | null> {
    const r = await db.query<{
      encuesta_id: number;
      beneficio_id: string;
      respondida_at: Date | null;
    }>(
      `SELECT encuesta_id, beneficio_id, respondida_at FROM encuesta_invitaciones WHERE token_hash = $1 ${bloquear ? 'FOR UPDATE' : ''}`,
      [tokenHash],
    );
    const f = r.rows[0];
    return f
      ? {
          encuestaId: f.encuesta_id,
          beneficioId: Number(f.beneficio_id),
          respondida: f.respondida_at !== null,
        }
      : null;
  },

  async marcarRespondida(db: Queryable, encuestaId: number, beneficioId: number): Promise<void> {
    await db.query(
      `UPDATE encuesta_invitaciones SET respondida_at = now() WHERE encuesta_id = $1 AND beneficio_id = $2`,
      [encuestaId, beneficioId],
    );
  },

  async localidadDeBeneficio(db: Queryable, beneficioId: number): Promise<number | null> {
    const r = await db.query<{ localidad_id: number | null }>(
      `SELECT s.localidad_id FROM beneficios b JOIN solicitudes s ON s.id = b.solicitud_id WHERE b.id = $1`,
      [beneficioId],
    );
    return r.rows[0]?.localidad_id ?? null;
  },

  async guardarRespuesta(
    db: Queryable,
    encuestaId: number,
    localidadId: number | null,
    respuestas: Respuestas,
  ): Promise<void> {
    await db.query(
      `INSERT INTO encuesta_respuestas (encuesta_id, localidad_id, dia, respuestas)
       VALUES ($1, $2, hoy_bogota(), $3)`,
      [encuestaId, localidadId, JSON.stringify(respuestas)],
    );
  },

  async respuestas(
    db: Queryable,
    encuestaId: number,
  ): Promise<{ respuestas: Respuestas; localidad: string | null }[]> {
    const r = await db.query<{ respuestas: Respuestas; localidad: string | null }>(
      `SELECT r.respuestas, c.nombre AS localidad FROM encuesta_respuestas r
         LEFT JOIN catalogo_items c ON c.id = r.localidad_id WHERE r.encuesta_id = $1 ORDER BY r.id`,
      [encuestaId],
    );
    return r.rows;
  },

  /** Promedio de satisfacción de las encuestas con respuestas, para el tablero (RF-SEG-04). */
  async todasConRespuestas(db: Queryable): Promise<number[]> {
    const r = await db.query<{ id: number }>(
      `SELECT DISTINCT encuesta_id AS id FROM encuesta_respuestas ORDER BY 1`,
    );
    return r.rows.map((x) => x.id);
  },
};
