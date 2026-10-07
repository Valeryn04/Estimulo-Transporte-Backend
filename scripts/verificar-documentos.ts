import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import { verificarDocumentos } from '../src/infrastructure/respaldo/respaldo.js';
import { DataCipher } from '../src/infrastructure/security/crypto.js';

// Auditoría de integridad del almacenamiento (RNF-06): comprueba que cada documento cargado exista, se descifre y
// coincida con su hash. Conviene ejecutarla de forma periódica y después de cada restauración.
const env = loadEnv();
const pool = createPool(env.databaseUrl);
try {
  const r = await verificarDocumentos(pool, env.storageDir, new DataCipher(env.encryption));
  console.log(
    `Documentos revisados: ${r.revisados} · correctos: ${r.correctos} · con problemas: ${r.problemas.length}`,
  );
  for (const p of r.problemas) console.error(`  #${p.id} ${p.ruta}: ${p.motivo}`);
  if (r.problemas.length > 0) process.exitCode = 1;
} finally {
  await pool.end();
}
