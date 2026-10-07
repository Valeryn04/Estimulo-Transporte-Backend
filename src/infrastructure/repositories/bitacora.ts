import type { Queryable } from '../db/pool.js';

export interface EntradaBitacora {
  usuarioId?: number | null;
  modulo: string;
  accion: string;
  entidad: string;
  entidadId?: string | number | null;
  solicitudId?: number | null;
  valorAnterior?: unknown;
  valorNuevo?: unknown;
  justificacion?: string | null;
  detalle?: Record<string, unknown>;
  ip?: string | null;
}

export interface RegistroBitacora {
  id: number;
  creadoAt: Date;
  usuarioId: number | null;
  modulo: string;
  accion: string;
  entidad: string;
  entidadId: string | null;
  solicitudId: number | null;
  valorAnterior: unknown;
  valorNuevo: unknown;
  justificacion: string | null;
  detalle: Record<string, unknown>;
  ip: string | null;
}

const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));

export const bitacoraRepo = {
  /** La bitácora es de solo inserción: no existen operaciones de edición ni borrado (RNF-07). */
  async registrar(db: Queryable, e: EntradaBitacora): Promise<void> {
    await db.query(
      `INSERT INTO bitacora (usuario_id, modulo, accion, entidad, entidad_id, solicitud_id,
                             valor_anterior, valor_nuevo, justificacion, detalle, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        e.usuarioId ?? null,
        e.modulo,
        e.accion,
        e.entidad,
        e.entidadId === undefined || e.entidadId === null ? null : String(e.entidadId),
        e.solicitudId ?? null,
        json(e.valorAnterior),
        json(e.valorNuevo),
        e.justificacion ?? null,
        JSON.stringify(e.detalle ?? {}),
        e.ip ?? null,
      ],
    );
  },
};
