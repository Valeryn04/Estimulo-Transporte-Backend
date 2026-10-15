import autocannon from 'autocannon';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadEnv } from '../src/config/env.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import { TokenService } from '../src/infrastructure/security/tokens.js';

// Prueba de carga del portal ciudadano (RNF-09): 500 usuarios concurrentes sin errores ni pérdida de información, con
// respuestas de menos de 3 segundos. Simula la apertura de una convocatoria: los 500 usuarios llegan a la vez y cada
// uno hace una vez cada operación (abrir el formulario, preinscribirse, abrir su caracterización y guardar su avance). La API corre en un proceso APARTE (como en producción) contra la base de PRUEBAS,
// que se borra y recrea, sin límites de peticiones por dirección (todas las conexiones salen de la misma) y con el
// correo en memoria.
//   npm run prueba:carga -- [--conexiones 500]
const arg = (nombre: string, defecto: number): number => {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? Number(process.argv[i + 1]) : defecto;
};
const CONEXIONES = arg('conexiones', 500);
const PUERTO = 3199;
const LIMITE_MS = 3000;

const urlBase = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
const env = loadEnv({ ...process.env, DATABASE_URL: urlBase });
if (!/test/i.test(env.databaseUrl)) {
  console.error('La prueba de carga solo se ejecuta contra una base cuyo nombre contenga «test».');
  process.exit(1);
}

const pool = createPool(env.databaseUrl, 5);
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await runMigrations(pool);

const servidor: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PUERTO),
    DATABASE_URL: env.databaseUrl,
    PRUEBA_CARGA: 'true',
    LOG_LEVEL: 'silent',
  },
  stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
});
const base = `http://127.0.0.1:${PUERTO}/api/v1`;
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {
    // todavía arrancando
  }
  if (i > 60) throw new Error('La API no arrancó.');
  await new Promise((r) => setTimeout(r, 500));
}

interface Resultado {
  nombre: string;
  solicitudes: number;
  exitosas: number;
  fallidas: number;
  errores: number;
  tiempoAgotado: number;
  p50: number;
  p99: number;
  maximo: number;
  porSegundo: number;
}

async function correr(
  nombre: string,
  o: Partial<autocannon.Options> & { url: string },
): Promise<Resultado> {
  const r = await autocannon({ connections: CONEXIONES, pipelining: 1, timeout: 30, ...o });
  const res: Resultado = {
    nombre,
    solicitudes: r.requests.total,
    exitosas: r['2xx'],
    fallidas: r.non2xx,
    errores: r.errors,
    tiempoAgotado: r.timeouts,
    p50: r.latency.p50,
    p99: r.latency.p99,
    maximo: r.latency.max,
    porSegundo: Math.round(r.requests.average),
  };
  console.log(
    `${nombre.padEnd(46)} ${String(res.solicitudes).padStart(6)} sol · 2xx ${res.exitosas} · fallidas ${res.fallidas} · errores ${res.errores} · timeouts ${res.tiempoAgotado} · p50 ${res.p50} ms · p99 ${res.p99} ms · máx ${res.maximo} ms · ${res.porSegundo}/s`,
  );
  return res;
}

const resultados: Resultado[] = [];
const fallos: string[] = [];
try {
  console.log(
    `Prueba de carga: ${CONEXIONES} usuarios simultáneos, una operación cada uno por escenario\n`,
  );

  // 1. La página de preinscripción: lo primero que carga cada persona.
  const formulario = (await (await fetch(`${base}/publico/preinscripcion/formulario`)).json()) as {
    tiposIdentificacion: { id: number; codigo: string }[];
    autorizacion: { version: number };
    formularioToken: string;
  };
  resultados.push(
    await correr('1. Abrir el formulario de preinscripción', {
      url: `${base}/publico/preinscripcion/formulario`,
      amount: CONEXIONES,
    }),
  );

  // 2. Pico de preinscripciones: cada petición es una persona distinta.
  const cc = formulario.tiposIdentificacion.find((t) => t.codigo === 'CC')!.id;
  // La protección contra robots exige que el formulario lleve abierto al menos 3 segundos antes de enviarlo.
  await new Promise((r) => setTimeout(r, 3500));
  let contador = 0;
  resultados.push(
    await correr('2. Preinscribirse (escritura en la base)', {
      url: `${base}/publico/preinscripciones`,
      amount: CONEXIONES,
      requests: [
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          setupRequest: (req) => {
            contador += 1;
            const n = 10_000_000 + contador * 2;
            return {
              ...req,
              body: JSON.stringify({
                pcdNombre: 'Persona de Prueba de Carga',
                pcdTipoIdentificacionId: cc,
                pcdNumero: String(n),
                cuidadorNombre: 'Cuidador de Prueba de Carga',
                cuidadorTipoIdentificacionId: cc,
                cuidadorNumero: String(n + 1),
                correo: `carga${contador}@correo.com`,
                correoConfirmacion: `carga${contador}@correo.com`,
                aceptaAutorizacion: true,
                autorizacionVersion: formulario.autorizacion.version,
                formularioToken: formulario.formularioToken,
              }),
            };
          },
        },
      ],
    }),
  );
  const creadas = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM solicitudes'))
    .rows[0]!.n;
  const confirmadas = resultados[1]!.exitosas;
  console.log(
    `   Solicitudes en la base: ${creadas} · confirmadas al usuario (201): ${confirmadas} · sin respuesta al cortar la prueba: ${Math.max(0, creadas - confirmadas)}`,
  );
  // Toda solicitud confirmada con 201 debe estar guardada. (Puede haber más guardadas que confirmadas: peticiones en
  // vuelo cuando la prueba cortó las conexiones.)
  if (creadas < confirmadas) {
    fallos.push(
      `Pérdida de información: ${confirmadas} solicitudes confirmadas pero solo ${creadas} guardadas.`,
    );
  }
  const duplicadas = (
    await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM (SELECT pcd_id FROM solicitudes GROUP BY pcd_id HAVING count(*) > 1) d',
    )
  ).rows[0]!.n;
  if (duplicadas > 0) fallos.push(`Hay ${duplicadas} personas con más de una solicitud.`);

  // 3. Abrir y guardar el avance de la caracterización, con la sesión de cada persona.
  await pool.query(
    `UPDATE solicitudes SET estado = 'CORREO_VERIFICADO', correo_verificado_at = now()`,
  );
  const ids = (
    await pool.query<{ id: number }>('SELECT id FROM solicitudes ORDER BY id LIMIT 600')
  ).rows.map((f) => f.id);
  const firmador = new TokenService(env.jwtSecret);
  const tokens = ids.map((id) => firmador.firmarCiudadano(id, 30));
  let k = 0;
  resultados.push(
    await correr('3. Abrir la caracterización (lectura)', {
      url: `${base}/publico/caracterizacion`,
      amount: CONEXIONES,
      requests: [
        {
          method: 'GET',
          setupRequest: (req) => ({
            ...req,
            headers: { authorization: `Bearer ${tokens[k++ % tokens.length]}` },
          }),
        },
      ],
    }),
  );
  let j = 0;
  const n4 = Math.min(CONEXIONES, tokens.length);
  resultados.push(
    await correr('4. Guardar el avance de la caracterización', {
      url: `${base}/publico/caracterizacion`,
      connections: n4,
      amount: n4,
      requests: [
        {
          method: 'PATCH',
          setupRequest: (req) => ({
            ...req,
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${tokens[j++ % tokens.length]}`,
            },
            body: JSON.stringify({ version: 0, celular: '3001234567', telefonoFijo: '6051234567' }),
          }),
        },
      ],
    }),
  );
  const guardadas = (
    await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM caracterizaciones')
  ).rows[0]!.n;
  console.log(
    `   Caracterizaciones guardadas: ${guardadas} · confirmadas (200): ${resultados[3]!.exitosas}`,
  );
  if (guardadas < resultados[3]!.exitosas) {
    fallos.push(
      `Pérdida de información al guardar el avance: ${resultados[3]!.exitosas} confirmadas y ${guardadas} guardadas.`,
    );
  }

  // Criterios de aceptación de RNF-09.
  for (const r of resultados) {
    if (r.errores > 0 || r.tiempoAgotado > 0)
      fallos.push(`${r.nombre}: ${r.errores} errores y ${r.tiempoAgotado} tiempos agotados.`);
    if (r.fallidas > 0) fallos.push(`${r.nombre}: ${r.fallidas} respuestas con error.`);
    if (r.p99 > LIMITE_MS)
      fallos.push(`${r.nombre}: el 99 % tardó ${r.p99} ms (límite ${LIMITE_MS} ms).`);
  }
} finally {
  // Apagado ordenado (termina los envíos en curso y cierra la base); si no responde, se fuerza.
  servidor.send('apagar');
  await new Promise<void>((r) => {
    servidor.once('exit', () => r());
    setTimeout(() => {
      servidor.kill();
      r();
    }, 5000);
  });
  await pool.end();
}

console.log(
  fallos.length === 0
    ? `\nRESULTADO: CUMPLE. ${CONEXIONES} usuarios concurrentes sin errores, sin pérdida de información y con el 99 % de las respuestas en menos de ${LIMITE_MS / 1000} s.`
    : `\nRESULTADO: NO CUMPLE\n- ${fallos.join('\n- ')}`,
);
process.exit(fallos.length === 0 ? 0 : 1);
