import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import {
  hacerRespaldo,
  purgarCopiasAntiguas,
  verificarRespaldo,
} from '../src/infrastructure/respaldo/respaldo.js';

// Copia de respaldo diaria (RNF-08): base de datos + documentos. Uso:
//   npm run respaldo -- [--salida ./respaldos] [--conservar-dias 30]
// Programe este comando una vez al día. Las llaves de cifrado NO se copian.
const env = loadEnv();
const arg = (nombre: string, defecto: string): string => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : defecto;
};
const salida = path.resolve(arg('salida', './respaldos'));
const dias = Number(arg('conservar-dias', '30'));

const pool = createPool(env.databaseUrl);
try {
  const inicio = Date.now();
  const { carpeta, manifiesto } = await hacerRespaldo({
    databaseUrl: env.databaseUrl,
    pool,
    storageDir: env.storageDir,
    salida,
  });
  const problemas = await verificarRespaldo(carpeta);
  if (problemas.length > 0) {
    console.error(`La copia se creó pero NO pasó la verificación:\n- ${problemas.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Copia creada y verificada en ${carpeta}\n` +
        `  Base de datos: ${(manifiesto.baseDeDatos.bytes / 1024).toFixed(0)} KB · ${manifiesto.migraciones.length} migraciones\n` +
        `  Documentos: ${manifiesto.documentos.archivos} archivos (${(manifiesto.documentos.bytes / 1024).toFixed(0)} KB)\n` +
        `  Duración: ${((Date.now() - inicio) / 1000).toFixed(1)} s`,
    );
    const borradas = await purgarCopiasAntiguas(salida, dias);
    if (borradas.length > 0)
      console.log(`  Copias con más de ${dias} días eliminadas: ${borradas.length}`);
  }
} finally {
  await pool.end();
}
