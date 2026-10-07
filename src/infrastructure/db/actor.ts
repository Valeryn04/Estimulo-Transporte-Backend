import type { Queryable } from './pool.js';

/**
 * Indica a la base de datos quién hace el cambio, para que los disparadores de versionado lo guarden en
 * `historial_versiones`. Solo tiene efecto dentro de la transacción en curso.
 */
export async function fijarActor(db: Queryable, usuarioId: number): Promise<void> {
  await db.query(`SELECT set_config('app.usuario_id', $1, true)`, [String(usuarioId)]);
}
