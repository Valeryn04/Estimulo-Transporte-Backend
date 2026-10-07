import { loadEnv } from './config/env.js';
import { crearDependencias } from './container.js';
import { runMigrations } from './infrastructure/db/migrator.js';
import { MemoryMailer } from './infrastructure/mail/mailer.js';
import { crearAplicacion } from './presentation/http/app.js';
import { logger } from './shared/logger.js';

const env = loadEnv();
const deps = crearDependencias(env);

// Solo para la prueba de carga (`npm run prueba:carga`): sin límites de peticiones por dirección (todas las conexiones
// salen de la misma) y con el correo en memoria. Nunca se admite en producción.
const modoCarga = process.env['PRUEBA_CARGA'] === 'true';
if (modoCarga) {
  if (env.nodeEnv === 'production') throw new Error('PRUEBA_CARGA no se puede usar en producción.');
  deps.mailer = new MemoryMailer();
}

// Las migraciones se aplican al arrancar: garantiza el esquema correcto en cada ambiente.
const aplicadas = await runMigrations(deps.pool);
if (aplicadas.length > 0) logger.info({ aplicadas }, 'Migraciones aplicadas');

const { app, servicios } = crearAplicacion(deps, modoCarga ? { limitarIntentos: false } : {});
const servidor = app.listen(env.port, () => {
  logger.info(
    { puerto: env.port, ambiente: env.nodeEnv },
    'API del Estímulo de Transporte en línea',
  );
});

// Tarea periódica: envío y reintento de los correos pendientes.
const tareaCorreos = setInterval(() => servicios.correos.despachar(), 30_000);
servicios.correos.despachar(); // por si quedaron correos pendientes de una ejecución anterior

async function apagar(senal: string) {
  logger.info({ senal }, 'Apagando');
  clearInterval(tareaCorreos);
  servidor.close();
  await servicios.correos.esperarDespachos();
  await deps.pool.end();
  process.exit(0);
}
// Apagado ordenado pedido por el proceso que lo lanzó (la prueba de carga), donde las señales no existen (Windows).
process.on('message', (m) => {
  if (m === 'apagar') void apagar('IPC');
});
process.on('SIGINT', () => void apagar('SIGINT'));
process.on('SIGTERM', () => void apagar('SIGTERM'));
