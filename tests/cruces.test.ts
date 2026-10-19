import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { interpretarCruce, normalizarIdentificacion } from '../src/domain/cruces.js';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';
import { ayudantesSolicitud } from './solicitudes.js';

const adm = '/api/v1/admin';

interface Alerta {
  cruceCodigo: string;
  nombre: string | null;
  cargadoAt: string | null;
  coincidencias: { persona: string; detalle: string }[];
}

describe('lectura de archivos de cruce', () => {
  it('normaliza identificaciones: sin puntos, guiones ni tildes', () => {
    expect(normalizarIdentificacion(' c.c. 1.234-5 ')).toBe('CC12345');
  });

  it('lee comas o punto y coma, comillas y encabezados con tildes o mayúsculas', () => {
    const r = interpretarCruce(
      '﻿identificación;Beneficio\r\n"1.000.123";"ESTE, ruta 1"\r\n2000456;Otro\r\n',
      'IDENTIFICACION',
      'beneficio',
    );
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    expect(r.registros.map((x) => [x.identificacion, x.detalle])).toEqual([
      ['1000123', 'ESTE, ruta 1'],
      ['2000456', 'Otro'],
    ]);
  });

  it('informa las filas con error y sigue con las demás', () => {
    const r = interpretarCruce(
      'IDENTIFICACION\n123\n\n99887766\n99887766\nAB\n55443322\n',
      'IDENTIFICACION',
      null,
    );
    if ('error' in r) throw new Error(r.error);
    expect(r.registros).toHaveLength(2);
    expect(r.errores.map((x) => x.fila)).toEqual([2, 5, 6]);
    expect(r.errores[1]?.mensaje).toContain('repetida');
  });

  it('rechaza el archivo si falta la columna de identificación', () => {
    const r = interpretarCruce('CEDULA,NOMBRE\n1,2\n', 'IDENTIFICACION', null);
    expect('error' in r && r.error).toContain('IDENTIFICACION');
  });
});

describe('archivos de cruce (RF-ADM-05) y alertas de la validación (RF-VAL-03)', () => {
  let e: Entorno;
  let admin: CuentaPrueba;
  let gestor: CuentaPrueba;
  let validador: CuentaPrueba;
  let ay: ReturnType<typeof ayudantesSolicitud>;

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    gestor = await crearCuenta(e, 'GESTOR_NOVEDADES');
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const cruces = (c: CuentaPrueba) => request(e.app).get(`${adm}/cruces`).set(auth(c));
  const cargar = (c: CuentaPrueba, id: number, csv: string, nombre = 'cruce.csv') =>
    request(e.app)
      .post(`${adm}/cruces/${id}/cargas`)
      .set(auth(c))
      .attach('archivo', Buffer.from(csv, 'utf8'), nombre);
  const estructura = async (codigo: string) =>
    ((await cruces(admin)).body.items as { id: number; codigo: string }[]).find(
      (x) => x.codigo === codigo,
    )!;

  it('trae las estructuras iniciales y solo las administra quien tiene el permiso', async () => {
    const r = await cruces(admin);
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: { codigo: string }) => x.codigo)).toEqual(
      expect.arrayContaining(['BENEFICIOS_INCOMPATIBLES', 'TRANSMETRO', 'DEFUNCIONES']),
    );
    expect((await cruces(gestor)).status).toBe(200);
    expect((await cruces(validador)).status).toBe(403);
  });

  it('crea, modifica, desactiva y versiona una estructura', async () => {
    const c = await request(e.app).post(`${adm}/cruces`).set(auth(admin)).send({
      nombre: 'Subsidios del Distrito',
      entidad: 'Hacienda',
      columnaIdentificacion: 'DOCUMENTO',
      columnaDetalle: 'SUBSIDIO',
      aplicaA: 'PCD',
    });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    expect(c.body.codigo).toBe('SUBSIDIOS_DEL_DISTRITO');
    const repetido = await request(e.app)
      .post(`${adm}/cruces`)
      .set(auth(admin))
      .send({ nombre: 'subsidios del distrito', columnaIdentificacion: 'X1', aplicaA: 'AMBOS' });
    expect(repetido.status).toBe(422);
    expect(repetido.body.error.errores[0].campo).toBe('nombre');
    const igual = await request(e.app).put(`${adm}/cruces/${c.body.id}`).set(auth(admin)).send({
      nombre: 'Subsidios del Distrito',
      columnaIdentificacion: 'DOCUMENTO',
      columnaDetalle: 'documento',
      aplicaA: 'PCD',
    });
    expect(igual.status).toBe(422);
    expect(igual.body.error.errores[0].campo).toBe('columnaDetalle');
    const m = await request(e.app).put(`${adm}/cruces/${c.body.id}`).set(auth(admin)).send({
      nombre: 'Subsidios del Distrito',
      entidad: 'Secretaría de Hacienda',
      columnaIdentificacion: 'DOCUMENTO',
      columnaDetalle: null,
      aplicaA: 'AMBOS',
    });
    expect(m.status).toBe(200);
    expect(m.body.aplicaA).toBe('AMBOS');
    expect(m.body.version).toBe(2);
    const off = await request(e.app).post(`${adm}/cruces/${c.body.id}/desactivar`).set(auth(admin));
    expect(off.body.activo).toBe(false);
    expect(
      (await request(e.app).post(`${adm}/cruces/${c.body.id}/desactivar`).set(auth(admin))).status,
    ).toBe(409);
    expect((await cargar(admin, c.body.id, 'DOCUMENTO\n123456\n')).status).toBe(409);
    const v = await request(e.app).get(`${adm}/cruces/${c.body.id}/versiones`).set(auth(admin));
    expect(v.body.items.length).toBeGreaterThanOrEqual(3);
  });

  it('carga un archivo: guarda las filas válidas y deja el reporte de errores', async () => {
    const est = await estructura('TRANSMETRO');
    const r = await cargar(
      gestor,
      est.id,
      'IDENTIFICACION,ESTADO\n11112222,ACTIVO\nXX\n11112222,ACTIVO\n33334444,ACTIVO\n',
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ filasTotal: 4, filasValidas: 2, filasError: 2, vigente: true });
    const rep = await request(e.app)
      .get(`${adm}/cruces/cargas/${r.body.id}/errores`)
      .set(auth(admin));
    expect(rep.status).toBe(200);
    expect(rep.headers['content-type']).toContain('text/csv');
    expect(rep.text).toContain('fila;error');
    expect(rep.text).toContain('3;');
    const lista = (await cruces(admin)).body.items.find((x: { id: number }) => x.id === est.id);
    expect(lista.vigente.id).toBe(r.body.id);
    // No se guarda el número en claro.
    const claro = await e.pool.query(
      `SELECT 1 FROM cruce_registros WHERE identificacion_huella LIKE '%11112222%' OR detalle LIKE '%11112222%'`,
    );
    expect(claro.rowCount).toBe(0);
  });

  it('la carga nueva reemplaza a la vigente y la anterior queda como historia', async () => {
    const est = await estructura('DEFUNCIONES');
    const a = await cargar(admin, est.id, 'IDENTIFICACION\n70001111\n');
    const b = await cargar(admin, est.id, 'IDENTIFICACION\n70002222\n');
    const h = await request(e.app).get(`${adm}/cruces/${est.id}/cargas`).set(auth(admin));
    const filas = h.body.items as { id: number; vigente: boolean }[];
    expect(filas.find((x) => x.id === b.body.id)?.vigente).toBe(true);
    expect(filas.find((x) => x.id === a.body.id)?.vigente).toBe(false);
  });

  it('rechaza archivos que no sirven', async () => {
    const est = await estructura('TRANSMETRO');
    const sinColumna = await cargar(admin, est.id, 'CEDULA\n1234567\n');
    expect(sinColumna.status).toBe(422);
    expect(sinColumna.body.error.errores[0].mensaje).toContain('IDENTIFICACION');
    const noCsv = await cargar(admin, est.id, 'IDENTIFICACION\n1234567\n', 'cruce.xlsx');
    expect(noCsv.status).toBe(422);
    const vacio = await cargar(admin, est.id, 'IDENTIFICACION\nxx\n');
    expect(vacio.status).toBe(422);
    const sinArchivo = await request(e.app).post(`${adm}/cruces/${est.id}/cargas`).set(auth(admin));
    expect(sinArchivo.status).toBe(422);
    expect((await cargar(validador, est.id, 'IDENTIFICACION\n1234567\n')).status).toBe(403);
    expect((await cargar(admin, 99999, 'IDENTIFICACION\n1234567\n')).status).toBe(404);
  });

  it('el validador ve la alerta cuando la persona o su cuidador están en el archivo', async () => {
    const s = await ay.solicitudRadicada();
    const est = await estructura('BENEFICIOS_INCOMPATIBLES');
    // Al tomar el caso se arma su lista de chequeo, con el requisito que usa este cruce.
    await request(e.app)
      .post(`${adm}/validacion/casos/${s.solicitudId}/tomar`)
      .set(auth(validador));
    const alertasDe = async () =>
      (await request(e.app).get(`${adm}/validacion/casos/${s.solicitudId}`).set(auth(validador)))
        .body.alertas as Alerta[];
    const antes = (await alertasDe()).find((x) => x.cruceCodigo === 'BENEFICIOS_INCOMPATIBLES')!;
    expect(antes.coincidencias).toEqual([]);
    const cuidador = String(Number(s.numero) + 1);
    const c = await cargar(
      admin,
      est.id,
      `Identificación,Beneficio\n${s.numero},ESTE\n${cuidador},Otro apoyo\n99999999,Ajeno\n`,
    );
    expect(c.status).toBe(201);
    const a = (await alertasDe()).find((x) => x.cruceCodigo === 'BENEFICIOS_INCOMPATIBLES')!;
    expect(a.nombre).toBe('Apoyos de transporte incompatibles');
    expect(a.cargadoAt).not.toBeNull();
    expect(a.coincidencias).toEqual(
      expect.arrayContaining([
        { persona: 'PCD', detalle: 'ESTE' },
        { persona: 'CUIDADOR', detalle: 'Otro apoyo' },
      ]),
    );
    // Una estructura que solo busca a la persona con discapacidad ignora al cuidador.
    await request(e.app).put(`${adm}/cruces/${est.id}`).set(auth(admin)).send({
      nombre: 'Apoyos de transporte incompatibles',
      columnaIdentificacion: 'IDENTIFICACION',
      columnaDetalle: 'BENEFICIO',
      aplicaA: 'PCD',
    });
    expect((await alertasDe())[0]?.coincidencias.map((x) => x.persona)).toEqual(['PCD']);
  });

  it('un requisito solo puede usar un cruce que exista y esté activo', async () => {
    const base = { nombre: 'Prueba de cruce', aplicaA: 'COMUN', campos: [], documentoId: null };
    const mal = await request(e.app)
      .post(`${adm}/requisitos`)
      .set(auth(admin))
      .send({ ...base, cruceCodigo: 'NO_EXISTE' });
    expect(mal.status).toBe(422);
    const bien = await request(e.app)
      .post(`${adm}/requisitos`)
      .set(auth(admin))
      .send({ ...base, cruceCodigo: 'DEFUNCIONES' });
    expect(bien.status, JSON.stringify(bien.body)).toBe(201);
  });
});
