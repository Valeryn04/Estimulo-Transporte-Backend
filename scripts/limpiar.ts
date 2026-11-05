import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';

/**
 * SOLO PARA DESARROLLO: deja la base limpia, solo con los roles y los usuarios de los funcionarios (con su misma
 * contraseña y su mismo rol). Se borran las solicitudes, las personas, los documentos guardados, la bitácora y todo
 * lo demás, y la configuración vuelve a sus valores iniciales. Hágase un respaldo antes: npm run respaldo.
 * Uso: npm run limpiar -- --si
 */
const env = loadEnv();
if (env.nodeEnv === 'production') {
  console.error('Este comando no se puede ejecutar en producción.');
  process.exit(1);
}
if (!process.argv.includes('--si')) {
  console.error(
    `Esto borra TODOS los datos de ${new URL(env.databaseUrl).pathname.slice(1)} y deja solo los roles y los usuarios.\n` +
      'Si está seguro, ejecute: npm run limpiar -- --si',
  );
  process.exit(1);
}

interface UsuarioGuardado {
  usuario: string;
  nombres: string;
  correo: string;
  password_hash: string;
  protegido: boolean;
  debe_cambiar_password: boolean;
  rol: string | null;
}

const pool = createPool(env.databaseUrl);
try {
  const usuarios = (
    await pool.query<UsuarioGuardado>(
      `SELECT u.usuario, u.nombres, u.correo, u.password_hash, u.protegido, u.debe_cambiar_password, r.codigo AS rol
         FROM usuarios u
         LEFT JOIN usuario_rol ur ON ur.usuario_id = u.id
         LEFT JOIN roles r ON r.id = ur.rol_id
        ORDER BY u.id`,
    )
  ).rows;

  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);

  for (const u of usuarios) {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO usuarios (usuario, nombres, correo, password_hash, debe_cambiar_password, protegido)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [u.usuario, u.nombres, u.correo, u.password_hash, u.debe_cambiar_password, u.protegido],
    );
    if (u.rol) {
      await pool.query(
        `INSERT INTO usuario_rol (usuario_id, rol_id) SELECT $1, id FROM roles WHERE codigo = $2`,
        [r.rows[0]!.id, u.rol],
      );
    }
  }

  // Los documentos guardados de las solicitudes ya no tienen a quién pertenecer.
  const carpeta = path.resolve(env.storageDir);
  let borrados = 0;
  for (const nombre of await readdir(carpeta).catch(() => [] as string[])) {
    await rm(path.join(carpeta, nombre), { recursive: true, force: true });
    borrados++;
  }
  console.log(
    `Base limpia: ${usuarios.length} usuarios conservados con su rol; ${borrados} elementos borrados del almacén de documentos.`,
  );
} finally {
  await pool.end();
}
