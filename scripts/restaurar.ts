import path from 'node:path';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import {
  parsearConexion,
  restaurarRespaldo,
  verificarDocumentos,
  verificarRespaldo,
} from '../src/infrastructure/respaldo/respaldo.js';
import { DataCipher } from '../src/infrastructure/security/crypto.js';

// Restauración de una copia (RNF-08). Uso:
//   npm run restaurar -- --desde ./respaldos/AAAAMMDD-HHMMSS --base <url> --documentos <carpeta> --si
// Reemplaza el contenido de la base y de la carpeta de destino. Por seguridad no restaura sobre la base en uso
// (DATABASE_URL) salvo que se indique --sobre-produccion.
const env = loadEnv();
const arg = (nombre: string): string | undefined => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const desde = arg('desde');
// La base de destino se indica con su URL (--base) o con el nombre de una variable de entorno (--base-env), para no
// escribir la clave en la línea de comandos.
const nombreVariable = arg('base-env');
const base = arg('base') ?? (nombreVariable ? process.env[nombreVariable] : undefined);
const documentos = arg('documentos');
const uso =
  'Uso: npm run restaurar -- --desde <carpeta de la copia> (--base <url de la base de destino> | --base-env <VARIABLE>) --documentos <carpeta de destino> --si';

if (!desde || !base || !documentos) {
  console.error(uso);
  process.exit(1);
}
if (!process.argv.includes('--si')) {
  console.error(
    `Esto reemplazará el contenido de la base «${parsearConexion(base).database}».\n${uso}`,
  );
  process.exit(1);
}
const mismaBase = (a: string, b: string) => {
  const x = parsearConexion(a);
  const y = parsearConexion(b);
  return x.host === y.host && x.port === y.port && x.database === y.database;
};
if (mismaBase(base, env.databaseUrl) && !process.argv.includes('--sobre-produccion')) {
  console.error(
    'La base de destino es la que está en uso (DATABASE_URL). Restaure en otra base para probar, o agregue --sobre-produccion si de verdad quiere reemplazarla.',
  );
  process.exit(1);
}

const carpeta = path.resolve(desde);
const problemas = await verificarRespaldo(carpeta);
if (problemas.length > 0) {
  console.error(`La copia no es íntegra:\n- ${problemas.join('\n- ')}`);
  process.exit(1);
}
const destinoDocs = path.resolve(documentos);
const manifiesto = await restaurarRespaldo({ carpeta, databaseUrl: base, storageDir: destinoDocs });
console.log(`Copia del ${manifiesto.creadoAt} restaurada en «${parsearConexion(base).database}».`);

// Comprobación final: todos los documentos se descifran y coinciden con su hash.
const pool = createPool(base);
try {
  const filas = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM solicitudes');
  const r = await verificarDocumentos(pool, destinoDocs, new DataCipher(env.encryption));
  console.log(`  Solicitudes restauradas: ${filas.rows[0]?.n ?? 0}`);
  console.log(`  Documentos verificados: ${r.correctos} de ${r.revisados}`);
  if (r.problemas.length > 0) {
    console.error(
      `  Problemas:\n  - ${r.problemas.map((p) => `#${p.id} ${p.ruta}: ${p.motivo}`).join('\n  - ')}`,
    );
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
