import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';

// SOLO PARA DESARROLLO: borra TODOS los datos de la base configurada en DATABASE_URL y vuelve a crear el
// esquema. Exige --si como confirmación.
const env = loadEnv();
if (env.nodeEnv === 'production') {
  console.error('Este comando no se puede ejecutar en producción.');
  process.exit(1);
}
if (!process.argv.includes('--si')) {
  console.error(
    `Esto borrará TODOS los datos de ${new URL(env.databaseUrl).pathname.slice(1)}.\n` +
      'Si está seguro, ejecute: npm run db:reiniciar -- --si',
  );
  process.exit(1);
}

const pool = createPool(env.databaseUrl);
try {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const aplicadas = await runMigrations(pool);
  console.log(`Base de datos reiniciada (${aplicadas.length} migraciones aplicadas).`);
} finally {
  await pool.end();
}
