import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hacerRespaldo,
  nombreDeCopia,
  parsearConexion,
  purgarCopiasAntiguas,
  restaurarRespaldo,
  verificarDocumentos,
  verificarRespaldo,
} from '../src/infrastructure/respaldo/respaldo.js';
import { DataCipher } from '../src/infrastructure/security/crypto.js';
import { crearEntorno, type Entorno } from './helpers.js';

const pub = '/api/v1/publico';
const exe = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
const pgDisponible =
  spawnSync(process.env['PG_BIN'] ? path.join(process.env['PG_BIN'], exe) : exe, ['--version'])
    .status === 0;

describe('copias de respaldo y restauración (RNF-08, RNF-06)', () => {
  describe('utilidades', () => {
    it('lee la conexión de la URL, con clave codificada', () => {
      expect(parsearConexion('postgres://usr:cl%40ve%23@localhost:5433/mi_base')).toEqual({
        host: 'localhost',
        port: '5433',
        user: 'usr',
        password: 'cl@ve#',
        database: 'mi_base',
      });
    });

    it('nombra la copia con la fecha y la hora', () => {
      expect(nombreDeCopia(new Date(2026, 9, 6, 3, 5, 9))).toBe('20261006-030509');
    });

    it('elimina las copias más viejas del plazo pero nunca la más reciente', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'respaldos-'));
      try {
        for (const n of ['20260101-020000', '20260915-020000', '20261005-020000', 'otra-carpeta']) {
          await mkdir(path.join(dir, n));
        }
        const ahora = new Date(2026, 9, 6, 12, 0, 0);
        const borradas = await purgarCopiasAntiguas(dir, 30, ahora);
        expect(borradas).toEqual(['20260101-020000']);
        expect((await readdir(dir)).sort()).toEqual([
          '20260915-020000',
          '20261005-020000',
          'otra-carpeta',
        ]);
        // Aunque todas sean viejas, se conserva la última.
        const dos = await purgarCopiasAntiguas(dir, 1, new Date(2027, 0, 1));
        expect(dos).toEqual(['20260915-020000']);
        expect((await readdir(dir)).sort()).toEqual(['20261005-020000', 'otra-carpeta']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    it('una carpeta sin manifiesto no es una copia válida', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'respaldos-'));
      try {
        expect((await verificarRespaldo(dir))[0]).toContain('manifiesto');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  describe.skipIf(!pgDisponible)('copia y restauración completas', () => {
    let e: Entorno;
    let cc: number;
    let salida: string;
    let documentosNuevos: string;

    beforeAll(async () => {
      e = await crearEntorno();
      const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
      cc = f.tiposIdentificacion.find((t: { codigo: string }) => t.codigo === 'CC').id;
      salida = await mkdtemp(path.join(tmpdir(), 'respaldos-'));
      documentosNuevos = await mkdtemp(path.join(tmpdir(), 'documentos-restaurados-'));
    });
    afterAll(async () => {
      await e.cerrar();
      await rm(salida, { recursive: true, force: true });
      await rm(documentosNuevos, { recursive: true, force: true });
    });

    /** Una solicitud con un documento cargado. */
    async function conDocumento(contenido: Buffer): Promise<void> {
      const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
      e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 20_000);
      await request(e.app)
        .post(`${pub}/preinscripciones`)
        .send({
          pcdNombre: 'María Fernanda Pérez',
          pcdTipoIdentificacionId: cc,
          pcdNumero: '5550001',
          cuidadorNombre: 'Carlos López',
          cuidadorTipoIdentificacionId: cc,
          cuidadorNumero: '5550002',
          correo: 'familia@correo.com',
          correoConfirmacion: 'familia@correo.com',
          aceptaAutorizacion: true,
          autorizacionVersion: f.autorizacion.version,
          formularioToken: f.formularioToken,
        })
        .expect(201);
      await e.servicios.correos.esperarDespachos();
      const token = /token=([A-Za-z0-9_-]+)/.exec(e.mailer.ultimo().text)![1]!;
      await request(e.app).post(`${pub}/preinscripciones/verificar-correo`).send({ token });
      await e.servicios.correos.esperarDespachos();
      const enlace = /token=([A-Za-z0-9_-]+)/.exec(e.mailer.ultimo().text)![1]!;
      const sesion = await request(e.app).post(`${pub}/consulta/enlace`).send({ token: enlace });
      const bearer = { Authorization: `Bearer ${sesion.body.token}` };
      const docs = await request(e.app).get(`${pub}/caracterizacion/documentos`).set(bearer);
      await request(e.app)
        .post(`${pub}/caracterizacion/documentos/${docs.body.documentos[0].id}`)
        .set(bearer)
        .attach('archivo', contenido, 'identidad.pdf')
        .expect(201);
    }

    it('copia la base y los documentos, verifica la copia y restaura todo tal como estaba', async () => {
      const pdf = Buffer.from('%PDF-1.4\n% documento de prueba del respaldo\n%%EOF\n');
      await conDocumento(pdf);
      const antes = (await e.pool.query('SELECT count(*)::int AS n FROM solicitudes')).rows[0].n;

      const { carpeta, manifiesto } = await hacerRespaldo({
        databaseUrl: e.deps.env.databaseUrl,
        pool: e.pool,
        storageDir: e.deps.env.storageDir,
        salida,
      });
      expect(manifiesto.migraciones.length).toBeGreaterThanOrEqual(8);
      expect(manifiesto.documentos.archivos).toBeGreaterThanOrEqual(1);
      expect(await verificarRespaldo(carpeta)).toEqual([]);
      // El documento va cifrado también en la copia.
      const guardados = await readdir(path.join(carpeta, 'documentos', 'solicitudes'), {
        recursive: true,
      });
      expect(guardados.length).toBeGreaterThan(0);

      // Se pierde todo: la base y la carpeta de documentos.
      await e.pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      expect(
        (await e.pool.query(`SELECT to_regclass('public.solicitudes') AS t`)).rows[0].t,
      ).toBeNull();

      await restaurarRespaldo({
        carpeta,
        databaseUrl: e.deps.env.databaseUrl,
        storageDir: documentosNuevos,
      });
      const despues = (await e.pool.query('SELECT count(*)::int AS n FROM solicitudes')).rows[0].n;
      expect(despues).toBe(antes);
      const integridad = await verificarDocumentos(
        e.pool,
        documentosNuevos,
        new DataCipher(e.deps.env.encryption),
      );
      expect(integridad).toMatchObject({ revisados: 1, correctos: 1, problemas: [] });
      // Las migraciones restauradas son las mismas: la API puede arrancar sobre esa base.
      const mig = (await e.pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0]
        .n;
      expect(mig).toBe(manifiesto.migraciones.length);
    });

    it('detecta una copia dañada y se niega a restaurarla', async () => {
      const dirs = (await readdir(salida)).sort();
      const carpeta = path.join(salida, dirs.at(-1)!);
      const dump = path.join(carpeta, 'base.dump');
      const original = await readFile(dump);
      await writeFile(dump, Buffer.concat([original, Buffer.from('x')]));
      try {
        const problemas = await verificarRespaldo(carpeta);
        expect(problemas[0]).toContain('base de datos');
        await expect(
          restaurarRespaldo({
            carpeta,
            databaseUrl: e.deps.env.databaseUrl,
            storageDir: documentosNuevos,
          }),
        ).rejects.toThrow(/no es íntegra/);
      } finally {
        await writeFile(dump, original);
      }
    });

    it('la verificación de documentos detecta un archivo alterado o faltante', async () => {
      const cipher = new DataCipher(e.deps.env.encryption);
      const ruta = (await e.pool.query<{ ruta: string }>('SELECT ruta FROM documentos_solicitud'))
        .rows[0]!.ruta;
      const archivo = path.join(documentosNuevos, ruta);
      const original = await readFile(archivo);
      const alterado = Buffer.from(original);
      alterado[alterado.length - 1] = (alterado[alterado.length - 1]! + 1) % 256;
      await writeFile(archivo, alterado);
      const r1 = await verificarDocumentos(e.pool, documentosNuevos, cipher);
      expect(r1.problemas[0]?.motivo).toContain('descifrar');
      await rm(archivo);
      const r2 = await verificarDocumentos(e.pool, documentosNuevos, cipher);
      expect(r2.problemas[0]?.motivo).toContain('Falta el archivo');
      await writeFile(archivo, original);
      expect((await verificarDocumentos(e.pool, documentosNuevos, cipher)).problemas).toEqual([]);
    });
  });
});
