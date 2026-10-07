import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../migrations',
);
const LOCK_ID = 7_340_001;

/** Aplica en orden las migraciones SQL pendientes. Devuelve los nombres aplicados. */
export async function runMigrations(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      nombre text PRIMARY KEY,
      checksum char(64) NOT NULL,
      aplicada_at timestamptz NOT NULL DEFAULT now())`);
    const rows = (
      await client.query<{ nombre: string; checksum: string }>(
        'SELECT nombre, checksum FROM schema_migrations',
      )
    ).rows;
    const done = new Map(rows.map((r) => [r.nombre, r.checksum]));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);
      if (previous) {
        if (previous !== checksum) {
          throw new Error(
            `La migración ${file} ya fue aplicada y cambió. Cree una migración nueva en su lugar.`,
          );
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (nombre, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Falló la migración ${file}: ${(error as Error).message}`, {
          cause: error,
        });
      }
      applied.push(file);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}
