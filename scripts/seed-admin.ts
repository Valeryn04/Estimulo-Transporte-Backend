import { loadEnv } from '../src/config/env.js';
import { validarPassword } from '../src/domain/passwords.js';
import { createPool, withTransaction } from '../src/infrastructure/db/pool.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';
import { usuariosRepo } from '../src/infrastructure/repositories/usuarios.js';
import { bitacoraRepo } from '../src/infrastructure/repositories/bitacora.js';
import { hashPassword } from '../src/infrastructure/security/passwords.js';
import { ACCION, MODULO } from '../src/domain/acciones.js';

// Crea el administrador principal (protegido) si todavía no existe ninguno. Lee ADMIN_* del entorno.
const env = loadEnv();
const usuario = (process.env.ADMIN_USUARIO ?? 'admin').trim().toLowerCase();
const nombres = (process.env.ADMIN_NOMBRES ?? 'Administrador de la plataforma').trim();
const correo = (process.env.ADMIN_CORREO ?? '').trim();
const password = process.env.ADMIN_PASSWORD ?? '';

const errores = validarPassword(password, usuario);
if (!correo || errores.length > 0) {
  console.error(
    'Defina ADMIN_USUARIO, ADMIN_CORREO y ADMIN_PASSWORD en .env.' +
      (errores.length ? `\nLa contraseña no cumple la política: ${errores.join('; ')}.` : ''),
  );
  process.exit(1);
}

const pool = createPool(env.databaseUrl);
try {
  await runMigrations(pool);
  const yaExiste = await pool.query(`SELECT 1 FROM usuarios WHERE protegido LIMIT 1`);
  if (yaExiste.rowCount) {
    console.log('Ya existe un administrador principal. No se hizo ningún cambio.');
  } else {
    const hash = await hashPassword(password);
    await withTransaction(pool, async (tx) => {
      const id = await usuariosRepo.crear(tx, { usuario, nombres, correo, passwordHash: hash });
      await tx.query(`UPDATE usuarios SET protegido = true WHERE id = $1`, [id]);
      await tx.query(
        `INSERT INTO usuario_rol (usuario_id, rol_id) SELECT $1, id FROM roles WHERE codigo = 'ADMINISTRADOR'`,
        [id],
      );
      await bitacoraRepo.registrar(tx, {
        modulo: MODULO.USUARIOS,
        accion: ACCION.USUARIO_CREADO,
        entidad: 'usuario',
        entidadId: id,
        detalle: { origen: 'seed-admin', usuario },
      });
    });
    console.log(
      `Administrador principal «${usuario}» creado. Deberá cambiar la contraseña al ingresar.`,
    );
  }
} finally {
  await pool.end();
}
