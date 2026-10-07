import pg from 'pg';

// int8 (bigint) llega como número: los identificadores nunca superan 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// date y time se manejan como cadenas ISO ('YYYY-MM-DD', 'HH:MM:SS'), sin conversión de zona horaria.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1083, (v) => v);

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Cualquier cosa que ejecute consultas: el pool o un cliente dentro de una transacción. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(connectionString: string, max = 10): Pool {
  return new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000 });
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
