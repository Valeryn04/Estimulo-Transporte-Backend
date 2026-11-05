import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auth,
  crearCuenta,
  crearEntorno,
  pdfConHojas,
  type CuentaPrueba,
  type Entorno,
} from './helpers.js';

const pub = '/api/v1/publico';
const admin = '/api/v1/admin';

interface Item {
  id: number;
  codigo: string;
  nombre: string;
}
interface Doc {
  id: number;
  codigo: string;
  nombre: string;
  aplicaA: string;
  obligatorio: boolean;
  generado: boolean;
  automatico?: boolean;
  hojasMinimas: number;
  estado: string;
  reemplazos: number;
  tieneModelo: boolean;
  archivo: { nombre: string; formato: string; tamanoBytes: number; sha256: string } | null;
}

/** Archivos mínimos pero con el contenido real de cada formato. */
const pdf = (relleno = 'contenido') =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${relleno}\n%%EOF\n`);
const jpg = (n = 2000) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n, 7)]);
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(300, 3),
  ]);
const docx = () =>
  Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('[Content_Types].xml word/document.xml'),
  ]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('documentos soporte y radicación (RF-CAR-03, RF-CAR-04, RNF-06)', () => {
  let e: Entorno;
  let cc: number;
  let administrador: CuentaPrueba;
  let consecutivo = 9_000_000;

  beforeAll(async () => {
    e = await crearEntorno();
    administrador = await crearCuenta(e, 'ADMINISTRADOR');
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
    cc = f.tiposIdentificacion.find((t: Item) => t.codigo === 'CC').id;
  });
  afterAll(async () => {
    await e.cerrar();
  });
  beforeEach(async () => {
    await e.servicios.correos.esperarDespachos();
    e.mailer.enviados.length = 0;
    e.reloj.ahora = new Date();
  });

  const tokenDe = (texto: string) => /token=([A-Za-z0-9_-]+)/.exec(texto)![1]!;

  async function persona(opciones: { verificar?: boolean } = {}) {
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
    e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 60_000);
    consecutivo += 2;
    const numero = String(consecutivo);
    const r = await request(e.app)
      .post(`${pub}/preinscripciones`)
      .send({
        pcdNombre: 'María Fernanda Pérez',
        pcdTipoIdentificacionId: cc,
        pcdNumero: numero,
        cuidadorNombre: 'Carlos López',
        cuidadorTipoIdentificacionId: cc,
        cuidadorNumero: String(consecutivo + 1),
        correo: 'familia@correo.com',
        correoConfirmacion: 'familia@correo.com',
        aceptaAutorizacion: true,
        autorizacionVersion: f.autorizacion.version,
        formularioToken: f.formularioToken,
      });
    expect(r.status).toBe(201);
    await e.servicios.correos.esperarDespachos();
    const solicitudId = (
      await e.pool.query<{ id: number }>(
        `SELECT s.id FROM solicitudes s JOIN personas p ON p.id = s.pcd_id WHERE p.numero_identificacion = $1`,
        [numero],
      )
    ).rows[0]!.id;
    if (opciones.verificar === false) {
      return { solicitudId, numero, token: e.deps.tokens.firmarCiudadano(solicitudId, 30) };
    }
    await request(e.app)
      .post(`${pub}/preinscripciones/verificar-correo`)
      .send({ token: tokenDe(e.mailer.ultimo().text) });
    await e.servicios.correos.esperarDespachos();
    const sesion = await request(e.app)
      .post(`${pub}/consulta/enlace`)
      .send({ token: tokenDe(e.mailer.ultimo().text) });
    e.mailer.enviados.length = 0;
    return { solicitudId, numero, token: sesion.body.token as string };
  }

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const lista = async (t: string) =>
    (await request(e.app).get(`${pub}/caracterizacion/documentos`).set(bearer(t))).body as {
      editable: boolean;
      reglas: { formatos: string[]; maxMb: number };
      documentos: Doc[];
      resumen: { obligatorios: number; cargados: number; completo: boolean };
    };
  const subir = (t: string, docId: number, contenido: Buffer, nombre: string) =>
    request(e.app)
      .post(`${pub}/caracterizacion/documentos/${docId}`)
      .set(bearer(t))
      .attach('archivo', contenido, nombre);
  const caracterizar = async (t: string, cuidador: boolean) => {
    const c = (await request(e.app).get(`${pub}/caracterizacion`).set(bearer(t))).body;
    const id = (l: Item[], codigo: string) => l.find((i) => i.codigo === codigo)!.id;
    const r = await request(e.app)
      .patch(`${pub}/caracterizacion`)
      .set(bearer(t))
      .send({
        version: c.version,
        generoId: id(c.catalogos.generos, 'FEMENINO'),
        celular: '3001234567',
        ocupacionId: id(c.catalogos.ocupaciones, 'DESEMPLEADO'),
        epsId: id(c.catalogos.eps, 'SANITAS'),
        embarazo: 'NO',
        recibeSubsidios: false,
        requiereCuidador: cuidador,
        ...(cuidador
          ? {
              cuidadorGeneroId: id(c.catalogos.generos, 'MASCULINO'),
              cuidadorCelular: '3109876543',
              cuidadorCorreo: 'carlos@correo.com',
            }
          : {}),
      });
    expect(r.status).toBe(200);
  };
  /** Carga todos los documentos obligatorios que le corresponden. */
  const cargarTodos = async (t: string) => {
    for (const d of (await lista(t)).documentos.filter(
      (x) => x.obligatorio && !x.generado && !x.automatico,
    )) {
      const contenido = d.hojasMinimas > 1 ? await pdfConHojas(d.hojasMinimas) : pdf(d.codigo);
      expect((await subir(t, d.id, contenido, `${d.codigo}.pdf`)).status).toBe(201);
    }
  };
  const idDoc = async (t: string, codigo: string) =>
    (await lista(t)).documentos.find((d) => d.codigo === codigo)!.id;

  describe('lista de documentos exigidos (RF-CAR-03)', () => {
    it('exige la sesión del ciudadano', async () => {
      expect((await request(e.app).get(`${pub}/caracterizacion/documentos`)).status).toBe(401);
      expect((await request(e.app).post(`${pub}/caracterizacion/documentos/1`)).status).toBe(401);
      expect((await request(e.app).post(`${pub}/caracterizacion/radicar`)).status).toBe(401);
    });

    it('sin cuidador solo pide los de la PCD y el común; con cuidador agrega los suyos', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      const sin = await lista(p.token);
      expect(sin.documentos.map((d) => d.aplicaA)).not.toContain('CUIDADOR');
      expect(sin.documentos.map((d) => d.codigo)).toEqual(
        expect.arrayContaining(['PCD_DOCUMENTO_IDENTIDAD', 'COMUN_CARTA_SOLICITUD']),
      );
      expect(sin.resumen).toMatchObject({ obligatorios: 4, cargados: 0, completo: false });
      await caracterizar(p.token, true).catch(() => undefined);
      const c = (await request(e.app).get(`${pub}/caracterizacion`).set(bearer(p.token))).body;
      await request(e.app).patch(`${pub}/caracterizacion`).set(bearer(p.token)).send({
        version: c.version,
        requiereCuidador: true,
        cuidadorGeneroId: c.catalogos.generos[0].id,
        cuidadorCelular: '3109876543',
        cuidadorCorreo: 'carlos@correo.com',
      });
      const con = await lista(p.token);
      expect(con.documentos.map((d) => d.aplicaA)).toContain('CUIDADOR');
      expect(con.resumen.obligatorios).toBe(6);
    });

    it('trae las reglas vigentes (formatos y tamaño) y cada documento con su estado pendiente', async () => {
      const p = await persona();
      const l = await lista(p.token);
      expect(l.reglas).toEqual({ formatos: ['pdf', 'jpg', 'png'], maxMb: 5 });
      expect(l.editable).toBe(true);
      expect(l.documentos.every((d) => d.estado === 'PENDIENTE' && d.archivo === null)).toBe(true);
    });

    it('un documento desactivado deja de pedirse', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      await e.pool.query(`UPDATE documentos_requeridos SET activo = false WHERE id = $1`, [id]);
      expect((await lista(p.token)).documentos.map((d) => d.id)).not.toContain(id);
      expect((await subir(p.token, id, pdf(), 'afiliacion.pdf')).status).toBe(404);
      await e.pool.query(`UPDATE documentos_requeridos SET activo = true WHERE id = $1`, [id]);
    });
  });

  describe('carga de archivos (RNF-06)', () => {
    it('acepta PDF, JPG y PNG y registra fecha, tamaño y hash de integridad', async () => {
      const p = await persona();
      await caracterizar(p.token, true);
      // Los documentos de una hoja que se suben a mano (las cartas las genera el sistema).
      const l = await lista(p.token);
      const [a, b, c] = l.documentos.filter(
        (d) => !d.generado && !d.automatico && d.hojasMinimas === 1,
      );
      const archivos = [
        { d: a!, contenido: pdf(), nombre: 'identidad.pdf', formato: 'pdf' },
        { d: b!, contenido: jpg(), nombre: 'FOTO.JPEG', formato: 'jpg' },
        { d: c!, contenido: png(), nombre: 'soporte.png', formato: 'png' },
      ];
      for (const x of archivos) {
        const r = await subir(p.token, x.d.id, x.contenido, x.nombre);
        expect(r.status, x.nombre).toBe(201);
        expect(r.body.estado).toBe('CARGADO');
        expect(r.body.archivo).toMatchObject({
          formato: x.formato,
          tamanoBytes: x.contenido.length,
          sha256: sha(x.contenido),
        });
      }
      const despues = await lista(p.token);
      expect(despues.resumen.cargados).toBe(3);
      const fila = (
        await e.pool.query(
          `SELECT * FROM documentos_solicitud WHERE solicitud_id = $1 ORDER BY id`,
          [p.solicitudId],
        )
      ).rows[0];
      expect(fila.cargado_at).toBeInstanceOf(Date);
      expect(fila.sha256).toBe(sha(pdf()));
      expect(fila.origen).toBe('CIUDADANO');
    });

    it('conserva las tildes y eñes del nombre del archivo', async () => {
      const p = await persona();
      const r = await subir(
        p.token,
        await idDoc(p.token, 'PCD_SISBEN'),
        pdf(),
        'Cédula de Ñandú.pdf',
      );
      expect(r.status).toBe(201);
      expect(r.body.archivo.nombre).toBe('Cédula de Ñandú.pdf');
    });

    it('rechaza un archivo que pesa más del máximo con el tamaño y el límite en el mensaje', async () => {
      const p = await persona();
      const grande = Buffer.concat([pdf(), Buffer.alloc(5 * 1_048_576 + 10)]);
      const r = await subir(p.token, await idDoc(p.token, 'PCD_SISBEN'), grande, 'grande.pdf');
      expect(r.status).toBe(422);
      expect(r.body.error.errores[0]).toMatchObject({ campo: 'archivo' });
      expect(r.body.error.errores[0].mensaje).toMatch(/pesa 5,0 MB|pesa 5,\d MB/);
      expect(r.body.error.errores[0].mensaje).toContain('máximo permitido es 5 MB');
    });

    it('rechaza lo que no es PDF, JPG o PNG aunque el nombre lo diga (se revisa el contenido)', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      const falso = await subir(
        p.token,
        id,
        Buffer.from('MZ ejecutable disfrazado'),
        'documento.pdf',
      );
      expect(falso.status).toBe(422);
      expect(falso.body.error.errores[0].mensaje).toContain('Solo se aceptan archivos');
      const texto = await subir(p.token, id, Buffer.from('hola'), 'nota.txt');
      expect(texto.status).toBe(422);
      const gif = await subir(p.token, id, Buffer.from('GIF89a....'), 'imagen.gif');
      expect(gif.status).toBe(422);
      expect((await lista(p.token)).resumen.cargados).toBe(0);
    });

    it('rechaza un archivo cuya extensión no corresponde a su contenido', async () => {
      const p = await persona();
      const r = await subir(p.token, await idDoc(p.token, 'PCD_SISBEN'), png(), 'foto.pdf');
      expect(r.status).toBe(422);
      expect(r.body.error.errores[0].mensaje).toContain('no corresponde a su extensión');
    });

    it('rechaza un archivo vacío y una petición sin archivo', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      expect((await subir(p.token, id, Buffer.alloc(0), 'vacio.pdf')).status).toBe(422);
      const sin = await request(e.app)
        .post(`${pub}/caracterizacion/documentos/${id}`)
        .set(bearer(p.token));
      expect(sin.status).toBe(422);
      expect(sin.body.error.errores[0].mensaje).toContain('Seleccione el archivo');
    });

    it('respeta los parámetros: un formato que la Gerencia deja de permitir se rechaza', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      await e.pool.query(
        `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('archivo_formatos', 'pdf', 'prueba')`,
      );
      try {
        expect((await lista(p.token)).reglas.formatos).toEqual(['pdf']);
        const r = await subir(p.token, id, jpg(), 'foto.jpg');
        expect(r.status).toBe(422);
        expect(r.body.error.errores[0].mensaje).toContain('Solo se aceptan archivos PDF');
        expect((await subir(p.token, id, pdf(), 'ok.pdf')).status).toBe(201);
      } finally {
        await e.pool.query(
          `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('archivo_formatos', 'pdf,jpg,png', 'restaurar')`,
        );
      }
    });

    it('respeta el tamaño máximo parametrizado', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      await e.pool.query(
        `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('archivo_max_mb', '1', 'prueba')`,
      );
      try {
        const r = await subir(
          p.token,
          id,
          Buffer.concat([pdf(), Buffer.alloc(1_100_000)]),
          'a.pdf',
        );
        expect(r.status).toBe(422);
        expect(r.body.error.errores[0].mensaje).toContain('máximo permitido es 1 MB');
      } finally {
        await e.pool.query(
          `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('archivo_max_mb', '5', 'restaurar')`,
        );
      }
    });

    it('guarda el archivo cifrado: el contenido no queda en claro en el almacenamiento', async () => {
      const p = await persona();
      const contenido = pdf('texto-que-no-debe-verse-en-claro');
      await subir(p.token, await idDoc(p.token, 'PCD_SISBEN'), contenido, 'afiliacion.pdf');
      const ruta = (
        await e.pool.query<{ ruta: string }>(
          `SELECT ruta FROM documentos_solicitud WHERE solicitud_id = $1`,
          [p.solicitudId],
        )
      ).rows[0]!.ruta;
      const crudo = await readFile(path.join(e.deps.env.storageDir, ruta));
      expect(crudo.includes('texto-que-no-debe-verse-en-claro')).toBe(false);
      expect(crudo.subarray(0, 5).toString('latin1')).not.toBe('%PDF-');
      // Y se descarga descifrado e idéntico.
      const r = await request(e.app)
        .get(`${pub}/caracterizacion/documentos/${await idDoc(p.token, 'PCD_SISBEN')}/archivo`)
        .set(bearer(p.token))
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on('data', (d: Buffer) => partes.push(d));
          res.on('end', () => cb(null, Buffer.concat(partes)));
        });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('application/pdf');
      expect(r.headers['content-disposition']).toContain('attachment');
      expect(sha(r.body as Buffer)).toBe(sha(contenido));
    });

    it('un archivo alterado en el almacenamiento no se entrega (verificación de integridad)', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      await subir(p.token, id, pdf(), 'afiliacion.pdf');
      const fila = (
        await e.pool.query<{ ruta: string }>(
          `SELECT ruta FROM documentos_solicitud WHERE solicitud_id = $1`,
          [p.solicitudId],
        )
      ).rows[0]!;
      const { writeFile } = await import('node:fs/promises');
      const destino = path.join(e.deps.env.storageDir, fila.ruta);
      const original = await readFile(destino);
      original[original.length - 1] = (original[original.length - 1]! + 1) % 256;
      await writeFile(destino, original);
      const r = await request(e.app)
        .get(`${pub}/caracterizacion/documentos/${id}/archivo`)
        .set(bearer(p.token));
      expect(r.status).toBe(500);
    });

    it('cada persona solo descarga sus propios documentos', async () => {
      const a = await persona();
      const b = await persona();
      const id = await idDoc(a.token, 'PCD_SISBEN');
      await subir(a.token, id, pdf('de-a'), 'a.pdf');
      const r = await request(e.app)
        .get(`${pub}/caracterizacion/documentos/${id}/archivo`)
        .set(bearer(b.token));
      expect(r.status).toBe(404);
      expect((await lista(b.token)).resumen.cargados).toBe(0);
    });

    it('un documento que no existe responde 404 y un identificador inválido 400', async () => {
      const p = await persona();
      expect((await subir(p.token, 99999, pdf(), 'x.pdf')).status).toBe(404);
      const mal = await request(e.app)
        .post(`${pub}/caracterizacion/documentos/abc`)
        .set(bearer(p.token))
        .attach('archivo', pdf(), 'x.pdf');
      expect(mal.status).toBe(400);
    });
  });

  describe('reemplazo sin borrar (RNF-06)', () => {
    it('el archivo anterior queda como reemplazado y el nuevo es el vigente', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      const primero = pdf('primero');
      const segundo = jpg(3000);
      await subir(p.token, id, primero, 'v1.pdf');
      const r = await subir(p.token, id, segundo, 'v2.jpg');
      expect(r.body.reemplazos).toBe(1);
      expect(r.body.archivo.sha256).toBe(sha(segundo));
      const filas = (
        await e.pool.query(
          `SELECT estado, sha256 FROM documentos_solicitud WHERE solicitud_id = $1 ORDER BY id`,
          [p.solicitudId],
        )
      ).rows;
      expect(filas).toEqual([
        { estado: 'REEMPLAZADO', sha256: sha(primero) },
        { estado: 'CARGADO', sha256: sha(segundo) },
      ]);
      // Los dos archivos siguen en el almacenamiento.
      const total = await readdir(
        path.join(e.deps.env.storageDir, 'solicitudes', String(p.solicitudId)),
      );
      expect(total).toHaveLength(2);
    });

    it('un documento cargado no se puede borrar ni modificar en la base de datos', async () => {
      const p = await persona();
      await subir(p.token, await idDoc(p.token, 'PCD_SISBEN'), pdf(), 'a.pdf');
      await expect(e.pool.query(`DELETE FROM documentos_solicitud`)).rejects.toThrow(
        /no se pueden borrar/,
      );
      await expect(
        e.pool.query(`UPDATE documentos_solicitud SET sha256 = repeat('a', 64)`),
      ).rejects.toThrow(/inmutable/);
      await expect(
        e.pool.query(`UPDATE documentos_solicitud SET nombre_original = 'otro.pdf'`),
      ).rejects.toThrow(/inmutable/);
    });

    it('la bitácora registra cada carga con el hash, sin copiar el contenido', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_SISBEN');
      await subir(p.token, id, pdf('uno'), 'uno.pdf');
      await subir(p.token, id, pdf('dos'), 'dos.pdf');
      const b = await e.pool.query(
        `SELECT valor_nuevo, detalle FROM bitacora WHERE accion = 'DOCUMENTO_CARGADO' AND solicitud_id = $1 ORDER BY id`,
        [p.solicitudId],
      );
      expect(b.rows).toHaveLength(2);
      expect(b.rows[1].valor_nuevo.sha256).toBe(sha(pdf('dos')));
      expect(b.rows[1].detalle.reemplazaA).not.toBeNull();
    });
  });

  describe('documentos del cuidador (RF-CAR-02)', () => {
    it('si no requiere el servicio para el cuidador no se acepta ni se exige su documento', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      const id = (
        await e.pool.query<{ id: number }>(
          `SELECT id FROM documentos_requeridos WHERE codigo = 'CUIDADOR_DOCUMENTO_IDENTIDAD'`,
        )
      ).rows[0]!.id;
      const r = await subir(p.token, id, pdf(), 'cuidador.pdf');
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('DOCUMENTO_NO_APLICA');
    });
  });

  describe('radicación (RF-CAR-04)', () => {
    it('no deja enviar con datos o documentos faltantes y dice exactamente qué falta', async () => {
      const p = await persona();
      const r = await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token));
      expect(r.status).toBe(422);
      const mensajes = r.body.error.errores.map((x: { mensaje: string }) => x.mensaje).join(' | ');
      expect(mensajes).toContain('Género: elija una opción');
      expect(mensajes).toContain(
        'Falta cargar: Documento de identidad de la persona con discapacidad',
      );
      const estado = await e.pool.query(`SELECT estado, radicado FROM solicitudes WHERE id = $1`, [
        p.solicitudId,
      ]);
      expect(estado.rows[0]).toMatchObject({ estado: 'CORREO_VERIFICADO', radicado: null });
    });

    it('«revision» informa lo pendiente por separado: datos y documentos', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      const r = await request(e.app).get(`${pub}/caracterizacion/revision`).set(bearer(p.token));
      expect(r.body.completo).toBe(false);
      expect(r.body.datos).toEqual([]);
      expect(r.body.documentos).toHaveLength(4);
      expect(r.body.documentos[0].campo).toMatch(/^documento:\d+$/);
    });

    it('con todo completo radica: número único con fecha, estado «Radicada» y correo de notificación', async () => {
      const p = await persona();
      await caracterizar(p.token, true);
      await cargarTodos(p.token);
      const antes = new Date();
      const r = await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token));
      expect(r.status).toBe(201);
      expect(r.body.radicado).toMatch(/^EST-\d{4}-\d{6}$/);
      expect(new Date(r.body.radicadaAt).getTime()).toBeGreaterThanOrEqual(antes.getTime() - 5000);
      expect(r.body.estado).toEqual({ codigo: 'RADICADA', nombre: 'Radicada' });
      expect(r.body.aviso).toContain('no equivale a la aprobación');

      await e.servicios.correos.esperarDespachos();
      const m = e.mailer.ultimo();
      expect(m.subject).toContain(r.body.radicado);
      expect(m.text).toContain(`Número de radicado: ${r.body.radicado}`);
      expect(m.text).toContain('Estado: Radicada');
      expect(m.text).toMatch(/Siguiente paso: Espere la verificación/);
      expect(m.text).toMatch(/consulta\?token=[A-Za-z0-9_-]+/);
      expect(m.text).toContain('no equivale a la aprobación del beneficio');
      const correo = (
        await e.pool.query(`SELECT tipo, plantilla_version FROM correos ORDER BY id DESC LIMIT 1`)
      ).rows[0];
      expect(correo).toMatchObject({ tipo: 'CARACTERIZACION_RADICADA', plantilla_version: 1 });
      const b = await e.pool.query(
        `SELECT valor_nuevo FROM bitacora WHERE accion = 'SOLICITUD_RADICADA'`,
      );
      expect(b.rows.at(-1)!.valor_nuevo.radicado).toBe(r.body.radicado);
    });

    it('el enlace del correo de radicación abre la consulta y muestra el radicado', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      await cargarTodos(p.token);
      const radicado = (
        await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token))
      ).body.radicado;
      await e.servicios.correos.esperarDespachos();
      const enlace = tokenDe(e.mailer.ultimo().text);
      const sesion = await request(e.app).post(`${pub}/consulta/enlace`).send({ token: enlace });
      const estado = await request(e.app)
        .get(`${pub}/consulta/solicitud`)
        .set(bearer(sesion.body.token));
      expect(estado.body).toMatchObject({
        radicado,
        etapa: 'Radicación',
        estado: { codigo: 'RADICADA', nombre: 'Radicada' },
      });
      expect(estado.body.fechaRadicacion).not.toBeNull();
      expect(estado.body.siguientePaso).toContain('verificación de requisitos');
      expect(estado.body.comunicaciones[0]).toMatchObject({ nombre: 'Solicitud radicada' });
    });

    it('no se puede radicar dos veces y responde con el radicado ya asignado', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      await cargarTodos(p.token);
      const uno = await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token));
      const dos = await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token));
      expect(dos.status).toBe(409);
      expect(dos.body.error.codigo).toBe('YA_RADICADA');
      expect(dos.body.error.detalle.radicado).toBe(uno.body.radicado);
      const n = await e.pool.query(
        `SELECT count(*)::int AS n FROM correos WHERE solicitud_id = $1 AND tipo = 'CARACTERIZACION_RADICADA'`,
        [p.solicitudId],
      );
      expect(n.rows[0].n).toBe(1);
    });

    it('dos envíos simultáneos radican una sola vez', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      await cargarTodos(p.token);
      const [a, b] = await Promise.all([
        request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token)),
        request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token)),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
    });

    it('varias solicitudes reciben radicados distintos y consecutivos', async () => {
      const radicados: string[] = [];
      for (let i = 0; i < 3; i++) {
        const p = await persona();
        await caracterizar(p.token, false);
        await cargarTodos(p.token);
        radicados.push(
          (await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token))).body
            .radicado,
        );
      }
      expect(new Set(radicados).size).toBe(3);
      const n = radicados.map((r) => Number(r.slice(-6)));
      expect(n[1]).toBe(n[0]! + 1);
      expect(n[2]).toBe(n[1]! + 1);
    });

    it('radicadas simultáneamente desde muchas solicitudes, ningún número se repite', async () => {
      const personas = [await persona(), await persona(), await persona(), await persona()];
      for (const p of personas) {
        await caracterizar(p.token, false);
        await cargarTodos(p.token);
      }
      const r = await Promise.all(
        personas.map((p) =>
          request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token)),
        ),
      );
      expect(r.every((x) => x.status === 201)).toBe(true);
      expect(new Set(r.map((x) => x.body.radicado)).size).toBe(4);
    });

    it('una solicitud radicada ya no admite cambios ni documentos nuevos', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      await cargarTodos(p.token);
      await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token));
      const doc = await idDoc(p.token, 'PCD_SISBEN');
      const subida = await subir(p.token, doc, pdf('nuevo'), 'otro.pdf');
      expect(subida.status).toBe(409);
      expect(subida.body.error.codigo).toBe('SOLICITUD_NO_EDITABLE');
      const c = (await request(e.app).get(`${pub}/caracterizacion`).set(bearer(p.token))).body;
      expect(c.solicitud).toMatchObject({
        editable: false,
        estado: { codigo: 'RADICADA' },
        radicado: expect.stringMatching(/^EST-/),
      });
      const cambio = await request(e.app)
        .patch(`${pub}/caracterizacion`)
        .set(bearer(p.token))
        .send({ version: c.version, celular: '3000000000' });
      expect(cambio.status).toBe(409);
    });

    it('la base de datos no admite un radicado repetido ni con otro formato', async () => {
      const a = await persona();
      await caracterizar(a.token, false);
      await cargarTodos(a.token);
      const radicado = (
        await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(a.token))
      ).body.radicado;
      const b = await persona();
      await expect(
        e.pool.query(
          `UPDATE solicitudes SET estado = 'RADICADA', radicado = $2, radicada_at = now() WHERE id = $1`,
          [b.solicitudId, radicado],
        ),
      ).rejects.toThrow(/solicitudes_radicado_key/);
      await expect(
        e.pool.query(`UPDATE solicitudes SET radicado = 'ABC', radicada_at = now() WHERE id = $1`, [
          b.solicitudId,
        ]),
      ).rejects.toThrow(/radicado_check/);
    });

    it('no se puede radicar si el correo no está verificado', async () => {
      const p = await persona({ verificar: false });
      const r = await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token));
      expect(r.status).toBe(409);
    });
  });

  describe('consulta con el número de radicado (RF-PRE-05)', () => {
    it('el código llega al correo registrado y abre el estado de esa solicitud', async () => {
      const p = await persona();
      await caracterizar(p.token, false);
      await cargarTodos(p.token);
      const radicado = (
        await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token))
      ).body.radicado;
      await e.servicios.correos.esperarDespachos();
      e.mailer.enviados.length = 0;
      e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 120_000);

      const pedido = await request(e.app)
        .post(`${pub}/consulta/solicitar-codigo`)
        .send({ radicado });
      expect(pedido.status).toBe(202);
      await e.servicios.correos.esperarDespachos();
      const codigo = /\n\n(\d{6})\n\n/.exec(e.mailer.ultimo().text)![1]!;
      const sesion = await request(e.app)
        .post(`${pub}/consulta/verificar-codigo`)
        .send({ radicado, codigo });
      expect(sesion.status).toBe(200);
      const estado = await request(e.app)
        .get(`${pub}/consulta/solicitud`)
        .set(bearer(sesion.body.token));
      expect(estado.body.radicado).toBe(radicado);
    });

    it('un radicado inexistente responde igual que uno válido y no envía nada', async () => {
      const r = await request(e.app)
        .post(`${pub}/consulta/solicitar-codigo`)
        .send({ radicado: 'EST-2026-999999' });
      expect(r.status).toBe(202);
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(0);
      const v = await request(e.app)
        .post(`${pub}/consulta/verificar-codigo`)
        .send({ radicado: 'EST-2026-999999', codigo: '123456' });
      expect(v.status).toBe(401);
    });

    it('valida el formato del radicado y pide los datos si no se envía ninguno', async () => {
      const mal = await request(e.app)
        .post(`${pub}/consulta/solicitar-codigo`)
        .send({ radicado: 'ABC' });
      expect(mal.status).toBe(422);
      expect(mal.body.error.errores[0].mensaje).toContain('EST-2026-000123');
      const vacio = await request(e.app).post(`${pub}/consulta/solicitar-codigo`).send({});
      expect(vacio.status).toBe(422);
      expect(vacio.body.error.errores.map((x: { campo: string }) => x.campo)).toEqual(
        expect.arrayContaining(['tipoIdentificacionId', 'numero']),
      );
    });

    it('acepta el radicado en minúsculas', async () => {
      const r = await request(e.app)
        .post(`${pub}/consulta/solicitar-codigo`)
        .send({ radicado: 'est-2026-000001' });
      expect(r.status).toBe(202);
    });
  });

  describe('modelos de carta descargables (RF-CAR-03)', () => {
    const modelo = (cuenta: CuentaPrueba, id: number, contenido: Buffer, nombre: string) =>
      request(e.app)
        .put(`${admin}/documentos-requeridos/${id}/modelo`)
        .set(auth(cuenta))
        .attach('archivo', contenido, nombre);
    const idCarta = async () =>
      (
        await e.pool.query<{ id: number }>(
          `SELECT id FROM documentos_requeridos WHERE codigo = 'COMUN_CARTA_SOLICITUD'`,
        )
      ).rows[0]!.id;

    it('sin modelo publicado, la persona ve que no hay y la descarga responde 404', async () => {
      const p = await persona();
      const l = await lista(p.token);
      expect(l.documentos.find((d) => d.codigo === 'COMUN_CARTA_SOLICITUD')!.tieneModelo).toBe(
        false,
      );
      expect((await request(e.app).get(`${pub}/documentos/${await idCarta()}/modelo`)).status).toBe(
        404,
      );
    });

    it('la Gerencia publica el modelo y cualquier persona lo descarga sin iniciar sesión', async () => {
      const id = await idCarta();
      const contenido = pdf('modelo-de-carta');
      const r = await modelo(administrador, id, contenido, 'Carta de solicitud.pdf');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ documentoId: id, formato: 'pdf' });
      const d = await request(e.app)
        .get(`${pub}/documentos/${id}/modelo`)
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on('data', (x: Buffer) => partes.push(x));
          res.on('end', () => cb(null, Buffer.concat(partes)));
        });
      expect(d.status).toBe(200);
      expect(d.headers['content-disposition']).toContain('attachment');
      expect(decodeURIComponent(d.headers['content-disposition']!)).toContain(
        'Carta de solicitud.pdf',
      );
      expect(sha(d.body as Buffer)).toBe(sha(contenido));
      const p = await persona();
      expect((await lista(p.token)).documentos.find((x) => x.id === id)!.tieneModelo).toBe(true);
      const admin1 = (
        await request(e.app).get(`${admin}/documentos-requeridos`).set(auth(administrador))
      ).body.items.find((x: { id: number }) => x.id === id);
      expect(admin1.modelo).toMatchObject({ nombre: 'Carta de solicitud.pdf', formato: 'pdf' });
    });

    it('permite DOCX, rechaza otros formatos y deja registro en la bitácora', async () => {
      const id = await idCarta();
      expect((await modelo(administrador, id, docx(), 'carta.docx')).status).toBe(200);
      const malo = await modelo(administrador, id, Buffer.from('texto plano'), 'carta.txt');
      expect(malo.status).toBe(422);
      expect(malo.body.error.errores[0].mensaje).toContain('PDF, DOCX u ODT');
      const b = await e.pool.query(
        `SELECT usuario_id, valor_anterior, valor_nuevo FROM bitacora WHERE accion = 'MODELO_DOCUMENTO_GUARDADO' ORDER BY id DESC LIMIT 1`,
      );
      expect(b.rows[0].usuario_id).toBe(administrador.id);
      expect(b.rows[0].valor_nuevo.formato).toBe('docx');
      expect(b.rows[0].valor_anterior).not.toBeNull();
    });

    it('solo quien administra los catálogos publica modelos', async () => {
      const analista = await crearCuenta(e, 'ANALISTA');
      const id = await idCarta();
      expect((await modelo(analista, id, pdf(), 'x.pdf')).status).toBe(403);
      expect(
        (
          await request(e.app)
            .put(`${admin}/documentos-requeridos/${id}/modelo`)
            .attach('archivo', pdf(), 'x.pdf')
        ).status,
      ).toBe(401);
    });

    it('un documento inexistente responde 404', async () => {
      expect((await modelo(administrador, 99999, pdf(), 'x.pdf')).status).toBe(404);
    });
  });
  describe('certificado de dos hojas y cartas que genera el sistema (Gerencia de Desarrollo Social)', () => {
    it('el certificado de discapacidad exige un PDF con sus dos hojas (la segunda trae el QR)', async () => {
      const p = await persona();
      const id = await idDoc(p.token, 'PCD_CERTIFICADO_DISCAPACIDAD');
      const cert = (await lista(p.token)).documentos.find((d) => d.id === id)!;
      expect(cert.hojasMinimas).toBe(2);
      // Una sola hoja, una imagen o un archivo que no se puede leer no sirven.
      const una = await subir(p.token, id, await pdfConHojas(1), 'cert.pdf');
      expect(una.status).toBe(422);
      expect(una.body.error.errores[0].mensaje).toContain('tiene 1 hoja(s)');
      expect(una.body.error.errores[0].mensaje).toContain('código QR');
      const foto = await subir(p.token, id, jpg(), 'cert.jpg');
      expect(foto.status).toBe(422);
      expect(foto.body.error.errores[0].mensaje).toContain('un solo PDF');
      const roto = await subir(p.token, id, pdf('sin paginas'), 'cert.pdf');
      expect(roto.status).toBe(422);
      expect(roto.body.error.errores[0].mensaje).toContain('No pudimos leer el PDF');
      // Con las dos hojas se acepta.
      const ok = await subir(p.token, id, await pdfConHojas(2), 'cert.pdf');
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    });

    it('las cartas no se suben: las genera el sistema y no cuentan como faltantes', async () => {
      const p = await persona();
      await caracterizar(p.token, true);
      const l = await lista(p.token);
      const cartas = l.documentos.filter((d) => d.generado);
      expect(cartas.map((d) => d.codigo).sort()).toEqual([
        'COMUN_CARTA_SOLICITUD',
        'CUIDADOR_CARTA_CUIDADO',
      ]);
      expect(l.resumen.obligatorios).toBe(6);
      const r = await subir(p.token, cartas[0]!.id, pdf(), 'carta.pdf');
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('DOCUMENTO_GENERADO');
    });

    it('la carta se puede ver mientras se llena el formulario, con los datos escritos', async () => {
      const p = await persona();
      await caracterizar(p.token, true);
      const solicitud = (await lista(p.token)).documentos.find(
        (d) => d.codigo === 'COMUN_CARTA_SOLICITUD',
      )!;
      const r = await request(e.app)
        .get(`${pub}/caracterizacion/documentos/${solicitud.id}/carta`)
        .set(bearer(p.token))
        .buffer(true)
        .parse((res, cb) => {
          const partes: Buffer[] = [];
          res.on('data', (d: Buffer) => partes.push(d));
          res.on('end', () => cb(null, Buffer.concat(partes)));
        });
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('application/pdf');
      expect((r.body as Buffer).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      // Un documento que sí se sube no tiene vista previa de carta.
      const identidad = await idDoc(p.token, 'PCD_DOCUMENTO_IDENTIDAD');
      expect(
        (
          await request(e.app)
            .get(`${pub}/caracterizacion/documentos/${identidad}/carta`)
            .set(bearer(p.token))
        ).status,
      ).toBe(404);
    });

    it('al radicar se generan y se adjuntan solas, y quedan como documentos cargados de la solicitud', async () => {
      const p = await persona();
      await caracterizar(p.token, true);
      await cargarTodos(p.token);
      const r = await request(e.app).post(`${pub}/caracterizacion/radicar`).set(bearer(p.token));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const despues = await lista(p.token);
      for (const d of despues.documentos.filter((x) => x.generado)) {
        expect(d.estado).toBe('CARGADO');
        expect(d.archivo).toMatchObject({ formato: 'pdf' });
      }
      const nombres = despues.documentos
        .filter((x) => x.generado)
        .map((x) => x.archivo!.nombre)
        .sort();
      expect(nombres).toEqual(['carta-de-cuidado-y-contacto.pdf', 'carta-de-solicitud.pdf']);
      const bitacora = await e.pool.query(
        `SELECT detalle FROM bitacora WHERE accion = 'DOCUMENTO_CARGADO' AND solicitud_id = $1 AND detalle->>'generadoPorElSistema' = 'true'`,
        [p.solicitudId],
      );
      // Las dos cartas y la constancia del régimen de salud.
      expect(bitacora.rowCount).toBe(3);
    });

    it('generar de nuevo con los mismos datos no crea otra versión; con datos nuevos sí', async () => {
      const p = await persona();
      await caracterizar(p.token, true);
      const ctx = { ip: null };
      await e.servicios.documentos.generarCartas(p.solicitudId, ctx);
      await e.servicios.documentos.generarCartas(p.solicitudId, ctx);
      const total = async () =>
        Number(
          (
            await e.pool.query<{ n: string }>(
              `SELECT count(*) AS n FROM documentos_solicitud WHERE solicitud_id = $1`,
              [p.solicitudId],
            )
          ).rows[0]!.n,
        );
      expect(await total()).toBe(2);
      await e.pool.query(`UPDATE solicitudes SET direccion = 'Calle 99 # 1 - 1' WHERE id = $1`, [
        p.solicitudId,
      ]);
      await e.servicios.documentos.generarCartas(p.solicitudId, ctx);
      expect(await total()).toBe(4);
      const reemplazados = await e.pool.query(
        `SELECT count(*)::int AS n FROM documentos_solicitud WHERE solicitud_id = $1 AND estado = 'REEMPLAZADO'`,
        [p.solicitudId],
      );
      expect(reemplazados.rows[0].n).toBe(2);
    });
  });
});
