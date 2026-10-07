import type { TipoCorreo } from '../../domain/correos.js';
import type { Queryable } from '../db/pool.js';

export type EstadoCorreo = 'PENDIENTE' | 'ENVIADO' | 'ENTREGADO' | 'REBOTADO' | 'FALLIDO';

export interface CorreoFila {
  id: number;
  solicitudId: number | null;
  tipo: TipoCorreo;
  plantillaVersion: number;
  destinatario: string;
  asunto: string;
  cuerpo: string;
  estado: EstadoCorreo;
  intentos: number;
  messageId: string | null;
}

interface Fila {
  id: number;
  solicitud_id: number | null;
  tipo: TipoCorreo;
  plantilla_version: number;
  destinatario: string;
  asunto: string;
  cuerpo: string;
  estado: EstadoCorreo;
  intentos: number;
  message_id: string | null;
}

const mapear = (f: Fila): CorreoFila => ({
  id: f.id,
  solicitudId: f.solicitud_id,
  tipo: f.tipo,
  plantillaVersion: f.plantilla_version,
  destinatario: f.destinatario,
  asunto: f.asunto,
  cuerpo: f.cuerpo,
  estado: f.estado,
  intentos: f.intentos,
  messageId: f.message_id,
});

const COLS = `id, solicitud_id, tipo, plantilla_version, destinatario, asunto, cuerpo, estado,
              intentos, message_id`;

export const correosRepo = {
  async encolar(
    db: Queryable,
    d: {
      solicitudId: number | null;
      tipo: TipoCorreo;
      plantillaVersion: number;
      destinatario: string;
      asunto: string;
      cuerpo: string;
    },
  ): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO correos (solicitud_id, tipo, plantilla_version, destinatario, asunto, cuerpo)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [d.solicitudId, d.tipo, d.plantillaVersion, d.destinatario, d.asunto, d.cuerpo],
    );
    return (r.rows[0] as { id: number }).id;
  },

  /**
   * Reserva un lote de correos pendientes. Mientras se envían quedan «apartados» unos minutos: si el proceso se
   * cae, se reintentan solos. `SKIP LOCKED` evita que dos procesos tomen el mismo correo.
   */
  async reservarPendientes(
    db: Queryable,
    limite: number,
    minutosReserva: number,
  ): Promise<CorreoFila[]> {
    const r = await db.query<Fila>(
      `UPDATE correos SET proximo_intento_at = now() + make_interval(mins => $2)
        WHERE id IN (SELECT id FROM correos
                      WHERE estado = 'PENDIENTE' AND proximo_intento_at <= now()
                      ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING ${COLS}`,
      [limite, minutosReserva],
    );
    return r.rows.map(mapear);
  },

  async marcarEnviado(db: Queryable, id: number, messageId: string): Promise<void> {
    await db.query(
      `UPDATE correos SET estado = 'ENVIADO', intentos = intentos + 1, message_id = $2, enviado_at = now(),
                          ultimo_error = NULL
        WHERE id = $1`,
      [id, messageId],
    );
  },

  /** Falla temporal: se reintenta más tarde. */
  async programarReintento(
    db: Queryable,
    id: number,
    error: string,
    minutos: number,
  ): Promise<void> {
    await db.query(
      `UPDATE correos SET intentos = intentos + 1, ultimo_error = $2,
                          proximo_intento_at = now() + make_interval(mins => $3)
        WHERE id = $1`,
      [id, error.slice(0, 500), minutos],
    );
  },

  async marcarFinal(
    db: Queryable,
    id: number,
    estado: 'FALLIDO' | 'REBOTADO',
    error: string,
  ): Promise<void> {
    await db.query(
      `UPDATE correos SET estado = $2, intentos = intentos + 1, ultimo_error = $3,
                          rebote_motivo = CASE WHEN $2 = 'REBOTADO' THEN $3 ELSE rebote_motivo END
        WHERE id = $1`,
      [id, estado, error.slice(0, 500)],
    );
  },

  /** Reporte del proveedor de correo: entregado o rebotado (RNF-13). Devuelve si encontró el mensaje. */
  async registrarEvento(
    db: Queryable,
    messageId: string,
    evento: 'ENTREGADO' | 'REBOTADO',
    detalle: string | null,
  ): Promise<boolean> {
    const r = await db.query(
      `UPDATE correos
          SET estado = $2,
              entregado_at = CASE WHEN $2 = 'ENTREGADO' THEN now() ELSE entregado_at END,
              rebote_motivo = CASE WHEN $2 = 'REBOTADO' THEN $3 ELSE rebote_motivo END
        WHERE message_id = $1 AND estado IN ('ENVIADO', 'ENTREGADO', 'REBOTADO')`,
      [messageId, evento, detalle],
    );
    return (r.rowCount ?? 0) > 0;
  },

  async porId(db: Queryable, id: number): Promise<CorreoFila | null> {
    const r = await db.query<Fila>(`SELECT ${COLS} FROM correos WHERE id = $1`, [id]);
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },
};
