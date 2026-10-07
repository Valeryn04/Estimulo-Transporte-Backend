import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from '../db/pool.js';
import type { DataCipher } from '../security/crypto.js';

/**
 * Copias de respaldo y restauración (RNF-08): la base de datos con `pg_dump` y los documentos cargados (que ya están
 * cifrados). Cada copia lleva un manifiesto con la huella SHA-256 de cada pieza, para comprobar que no se dañó antes de
 * restaurarla.
 *
 * IMPORTANTE: las llaves de cifrado (`DATA_ENCRYPTION_KEYS`) NO van en la copia. Sin ellas, los documentos y los datos
 * sensibles no se pueden leer: guárdelas aparte, en un lugar seguro.
 */

export interface ManifiestoRespaldo {
  version: 1;
  creadoAt: string;
  baseDeDatos: { archivo: string; sha256: string; bytes: number; nombre: string };
  migraciones: string[];
  documentos: { carpeta: string; archivos: number; bytes: number; huella: string };
}

interface Conexion {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

export function parsearConexion(url: string): Conexion {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.slice(1),
  };
}

/** Carpeta de las herramientas de PostgreSQL (`PG_BIN`) o, si no se indica, las del PATH. */
function herramienta(nombre: 'pg_dump' | 'pg_restore'): string {
  const dir = process.env['PG_BIN'];
  const exe = process.platform === 'win32' ? `${nombre}.exe` : nombre;
  return dir ? path.join(dir, exe) : exe;
}

function ejecutar(comando: string, args: string[], password: string): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const proceso = spawn(comando, args, {
      env: { ...process.env, PGPASSWORD: password },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errores = '';
    proceso.stderr.on('data', (d: Buffer) => (errores += d.toString()));
    proceso.on('error', (e) =>
      rechazar(
        new Error(
          `No se pudo ejecutar ${path.basename(comando)}: ${e.message}. Instale las herramientas de PostgreSQL o indique su carpeta en PG_BIN.`,
        ),
      ),
    );
    proceso.on('close', (codigo) =>
      codigo === 0
        ? resolver()
        : rechazar(
            new Error(`${path.basename(comando)} terminó con error ${codigo}: ${errores.trim()}`),
          ),
    );
  });
}

export const sha256Archivo = async (ruta: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(ruta))
    .digest('hex');

/** Recorre una carpeta y devuelve sus archivos (rutas relativas, en orden) con su tamaño. */
async function listar(raiz: string, rel = ''): Promise<{ ruta: string; bytes: number }[]> {
  let salida: { ruta: string; bytes: number }[] = [];
  let entradas;
  try {
    entradas = await readdir(path.join(raiz, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entradas.sort((a, b) => a.name.localeCompare(b.name))) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) salida = salida.concat(await listar(raiz, r));
    else salida.push({ ruta: r, bytes: (await stat(path.join(raiz, r))).size });
  }
  return salida;
}

/** Huella de una carpeta: resume los nombres, tamaños y contenidos de todos sus archivos. */
async function huellaCarpeta(
  raiz: string,
): Promise<{ archivos: number; bytes: number; huella: string }> {
  const archivos = await listar(raiz);
  const h = createHash('sha256');
  let bytes = 0;
  for (const a of archivos) {
    h.update(`${a.ruta}:${a.bytes}:${await sha256Archivo(path.join(raiz, a.ruta))}\n`);
    bytes += a.bytes;
  }
  return { archivos: archivos.length, bytes, huella: h.digest('hex') };
}

const dosDigitos = (n: number) => String(n).padStart(2, '0');

/** AAAAMMDD-HHMMSS en la hora local del servidor. */
export function nombreDeCopia(fecha: Date): string {
  return (
    `${fecha.getFullYear()}${dosDigitos(fecha.getMonth() + 1)}${dosDigitos(fecha.getDate())}-` +
    `${dosDigitos(fecha.getHours())}${dosDigitos(fecha.getMinutes())}${dosDigitos(fecha.getSeconds())}`
  );
}

export interface OpcionesRespaldo {
  databaseUrl: string;
  pool: Pool;
  storageDir: string;
  salida: string;
  ahora?: Date;
}

/** Crea una copia de respaldo completa (base de datos y documentos) y devuelve su carpeta y su manifiesto. */
export async function hacerRespaldo(
  o: OpcionesRespaldo,
): Promise<{ carpeta: string; manifiesto: ManifiestoRespaldo }> {
  const c = parsearConexion(o.databaseUrl);
  const carpeta = path.join(o.salida, nombreDeCopia(o.ahora ?? new Date()));
  await mkdir(carpeta, { recursive: true });
  const dump = path.join(carpeta, 'base.dump');
  await ejecutar(
    herramienta('pg_dump'),
    [
      '-Fc',
      '-Z',
      '6',
      '--no-owner',
      '--no-privileges',
      '-h',
      c.host,
      '-p',
      c.port,
      '-U',
      c.user,
      '-d',
      c.database,
      '-f',
      dump,
    ],
    c.password,
  );
  const docs = path.join(carpeta, 'documentos');
  await mkdir(docs, { recursive: true });
  await cp(o.storageDir, docs, { recursive: true, force: false, errorOnExist: false }).catch(
    () => undefined,
  );
  const migraciones = (
    await o.pool.query<{ nombre: string }>('SELECT nombre FROM schema_migrations ORDER BY nombre')
  ).rows.map((f) => f.nombre);
  const resumen = await huellaCarpeta(docs);
  const manifiesto: ManifiestoRespaldo = {
    version: 1,
    creadoAt: (o.ahora ?? new Date()).toISOString(),
    baseDeDatos: {
      archivo: 'base.dump',
      sha256: await sha256Archivo(dump),
      bytes: (await stat(dump)).size,
      nombre: c.database,
    },
    migraciones,
    documentos: { carpeta: 'documentos', ...resumen },
  };
  await writeFile(
    path.join(carpeta, 'manifiesto.json'),
    JSON.stringify(manifiesto, null, 2),
    'utf8',
  );
  return { carpeta, manifiesto };
}

/** Comprueba que la copia está completa y sin daños: devuelve los problemas encontrados (vacío = íntegra). */
export async function verificarRespaldo(carpeta: string): Promise<string[]> {
  const problemas: string[] = [];
  let m: ManifiestoRespaldo;
  try {
    m = JSON.parse(
      await readFile(path.join(carpeta, 'manifiesto.json'), 'utf8'),
    ) as ManifiestoRespaldo;
  } catch {
    return ['No se encuentra el manifiesto de la copia (manifiesto.json).'];
  }
  try {
    if ((await sha256Archivo(path.join(carpeta, m.baseDeDatos.archivo))) !== m.baseDeDatos.sha256) {
      problemas.push(
        'El archivo de la base de datos no coincide con su huella: está dañado o fue modificado.',
      );
    }
  } catch {
    problemas.push('Falta el archivo de la base de datos.');
  }
  const docs = await huellaCarpeta(path.join(carpeta, m.documentos.carpeta));
  if (docs.archivos !== m.documentos.archivos || docs.huella !== m.documentos.huella) {
    problemas.push(
      `Los documentos no coinciden con el manifiesto (esperados ${m.documentos.archivos}, encontrados ${docs.archivos}).`,
    );
  }
  return problemas;
}

export interface OpcionesRestauracion {
  carpeta: string;
  databaseUrl: string;
  storageDir: string;
}

/**
 * Restaura una copia en la base y en la carpeta de documentos indicadas. Reemplaza lo que haya en la base de destino
 * (`--clean`). Se niega a restaurar una copia dañada.
 */
export async function restaurarRespaldo(o: OpcionesRestauracion): Promise<ManifiestoRespaldo> {
  const problemas = await verificarRespaldo(o.carpeta);
  if (problemas.length > 0) throw new Error(`La copia no es íntegra: ${problemas.join(' ')}`);
  const m = JSON.parse(
    await readFile(path.join(o.carpeta, 'manifiesto.json'), 'utf8'),
  ) as ManifiestoRespaldo;
  const c = parsearConexion(o.databaseUrl);
  await ejecutar(
    herramienta('pg_restore'),
    [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '-h',
      c.host,
      '-p',
      c.port,
      '-U',
      c.user,
      '-d',
      c.database,
      path.join(o.carpeta, m.baseDeDatos.archivo),
    ],
    c.password,
  );
  await mkdir(o.storageDir, { recursive: true });
  await cp(path.join(o.carpeta, m.documentos.carpeta), o.storageDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
  return m;
}

export interface ResultadoIntegridad {
  revisados: number;
  correctos: number;
  problemas: { id: number; ruta: string; motivo: string }[];
}

/**
 * Comprueba cada documento cargado: que el archivo exista, se pueda descifrar con las llaves vigentes y su contenido
 * coincida con el hash registrado. Sirve para auditar el almacenamiento y para confirmar una restauración (RNF-06).
 */
export async function verificarDocumentos(
  pool: Pool,
  storageDir: string,
  cipher: DataCipher,
): Promise<ResultadoIntegridad> {
  const filas = (
    await pool.query<{ id: number; ruta: string; sha256: string }>(
      'SELECT id, ruta, sha256 FROM documentos_solicitud ORDER BY id',
    )
  ).rows;
  const r: ResultadoIntegridad = { revisados: filas.length, correctos: 0, problemas: [] };
  for (const f of filas) {
    try {
      const contenido = cipher.descifrarBytes(await readFile(path.resolve(storageDir, f.ruta)));
      if (createHash('sha256').update(contenido).digest('hex') === f.sha256) r.correctos += 1;
      else
        r.problemas.push({
          id: f.id,
          ruta: f.ruta,
          motivo: 'El contenido no coincide con su hash.',
        });
    } catch (e) {
      const sinArchivo = (e as NodeJS.ErrnoException).code === 'ENOENT';
      r.problemas.push({
        id: f.id,
        ruta: f.ruta,
        motivo: sinArchivo
          ? 'Falta el archivo.'
          : 'No se pudo descifrar (archivo alterado o llave distinta).',
      });
    }
  }
  return r;
}

/**
 * Borra las copias más antiguas de `dias` días. Nunca borra la copia más reciente, aunque sea antigua: siempre
 * queda al menos una.
 */
export async function purgarCopiasAntiguas(
  salida: string,
  dias: number,
  ahora = new Date(),
): Promise<string[]> {
  let nombres: string[];
  try {
    nombres = (await readdir(salida)).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort();
  } catch {
    return [];
  }
  const limite = ahora.getTime() - dias * 86_400_000;
  const aBorrar = nombres.slice(0, -1).filter((n) => {
    const fecha = new Date(
      Number(n.slice(0, 4)),
      Number(n.slice(4, 6)) - 1,
      Number(n.slice(6, 8)),
      Number(n.slice(9, 11)),
      Number(n.slice(11, 13)),
      Number(n.slice(13, 15)),
    );
    return fecha.getTime() < limite;
  });
  for (const n of aBorrar) await rm(path.join(salida, n), { recursive: true, force: true });
  return aBorrar;
}
