import type { Queryable } from '../db/pool.js';

export interface SesionFila {
  id: string;
  usuarioId: number;
  tokenHash: string;
  anteriorHash: string | null;
  rotadoAt: Date;
  inicioAt: Date;
  ultimoUsoAt: Date;
  revocada: boolean;
}

interface Fila {
  id: string;
  usuario_id: number;
  token_hash: string;
  anterior_hash: string | null;
  rotado_at: Date;
  inicio_at: Date;
  ultimo_uso_at: Date;
  revocada_at: Date | null;
}

const mapear = (f: Fila): SesionFila => ({
  id: f.id,
  usuarioId: f.usuario_id,
  tokenHash: f.token_hash,
  anteriorHash: f.anterior_hash,
  rotadoAt: f.rotado_at,
  inicioAt: f.inicio_at,
  ultimoUsoAt: f.ultimo_uso_at,
  revocada: f.revocada_at !== null,
});

/** Sesiones de los usuarios internos (refresh tokens rotativos). Solo se guarda el hash del secreto. */
export const sesionesRepo = {
  async crear(db: Queryable, usuarioId: number, tokenHash: string, ahora: Date): Promise<string> {
    const r = await db.query<{ id: string }>(
      `INSERT INTO sesiones_internas (usuario_id, token_hash, inicio_at, ultimo_uso_at, rotado_at)
       VALUES ($1, $2, $3, $3, $3) RETURNING id`,
      [usuarioId, tokenHash, ahora],
    );
    return (r.rows[0] as { id: string }).id;
  },

  async porId(db: Queryable, id: string): Promise<SesionFila | null> {
    const r = await db.query<Fila>(
      `SELECT id, usuario_id, token_hash, anterior_hash, rotado_at, inicio_at, ultimo_uso_at, revocada_at
         FROM sesiones_internas WHERE id = $1`,
      [id],
    );
    return r.rows[0] ? mapear(r.rows[0]) : null;
  },

  /** Cambia el secreto solo si todavía es el esperado (evita que dos peticiones roten a la vez). */
  async rotar(
    db: Queryable,
    id: string,
    hashEsperado: string,
    hashNuevo: string,
    ahora: Date,
  ): Promise<boolean> {
    const r = await db.query(
      `UPDATE sesiones_internas
          SET anterior_hash = token_hash, token_hash = $3, rotado_at = $4, ultimo_uso_at = $4
        WHERE id = $1 AND token_hash = $2 AND revocada_at IS NULL`,
      [id, hashEsperado, hashNuevo, ahora],
    );
    return (r.rowCount ?? 0) === 1;
  },

  async registrarUso(db: Queryable, id: string, ahora: Date): Promise<void> {
    await db.query(`UPDATE sesiones_internas SET ultimo_uso_at = $2 WHERE id = $1`, [id, ahora]);
  },

  async revocar(db: Queryable, id: string, motivo: string, ahora: Date): Promise<void> {
    await db.query(
      `UPDATE sesiones_internas SET revocada_at = $3, motivo_revocacion = $2
        WHERE id = $1 AND revocada_at IS NULL`,
      [id, motivo, ahora],
    );
  },

  async revocarDeUsuario(
    db: Queryable,
    usuarioId: number,
    motivo: string,
    ahora: Date,
  ): Promise<void> {
    await db.query(
      `UPDATE sesiones_internas SET revocada_at = $3, motivo_revocacion = $2
        WHERE usuario_id = $1 AND revocada_at IS NULL`,
      [usuarioId, motivo, ahora],
    );
  },
};
