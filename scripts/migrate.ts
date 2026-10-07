import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';

const env = loadEnv();
const pool = createPool(env.databaseUrl);
try {
  const applied = await runMigrations(pool);
  console.log(
    applied.length
      ? `Migraciones aplicadas:\n - ${applied.join('\n - ')}`
      : 'Base de datos al día.',
  );
} finally {
  await pool.end();
}
