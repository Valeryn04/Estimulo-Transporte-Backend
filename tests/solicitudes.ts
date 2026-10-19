import request from 'supertest';
import { expect } from 'vitest';
import type { Entorno } from './helpers.js';

const pub = '/api/v1/publico';

interface Item {
  id: number;
  codigo: string;
  nombre: string;
}
export interface DocumentoPrueba {
  id: number;
  codigo: string;
  nombre: string;
  aplicaA: string;
  obligatorio: boolean;
  estado: string;
}

/** Archivo mínimo pero con el contenido real de un PDF. */
export const pdf = (relleno = 'contenido') =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${relleno}\n%%EOF\n`);

export const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const tokenDe = (texto: string) => /token=([A-Za-z0-9_-]+)/.exec(texto)![1]!;

/**
 * Ayudantes para las pruebas de las etapas posteriores: llevan una solicitud completa (preinscripción, correo
 * verificado, caracterización, documentos y radicado) por la API pública, como lo haría una persona.
 */
export function ayudantesSolicitud(e: Entorno) {
  let consecutivo = 30_000_000 + (Date.now() % 1_000_000) * 20;
  let cc = 0;

  const tipoCc = async () => {
    if (cc) return cc;
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
    cc = f.tiposIdentificacion.find((t: Item) => t.codigo === 'CC').id;
    return cc;
  };

  async function persona(opciones: { nombre?: string; correo?: string; localidad?: boolean } = {}) {
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
    e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 60_000);
    consecutivo += 2;
    const numero = String(consecutivo);
    const correo = opciones.correo ?? `familia${consecutivo}@correo.com`;
    const r = await request(e.app)
      .post(`${pub}/preinscripciones`)
      .send({
        pcdNombre: opciones.nombre ?? 'María Fernanda Pérez',
        pcdTipoIdentificacionId: await tipoCc(),
        pcdNumero: numero,
        cuidadorNombre: 'Carlos López',
        cuidadorTipoIdentificacionId: await tipoCc(),
        cuidadorNumero: String(consecutivo + 1),
        correo,
        correoConfirmacion: correo,
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
    await request(e.app)
      .post(`${pub}/preinscripciones/verificar-correo`)
      .send({ token: tokenDe(e.mailer.ultimo().text) });
    await e.servicios.correos.esperarDespachos();
    const sesion = await request(e.app)
      .post(`${pub}/consulta/enlace`)
      .send({ token: tokenDe(e.mailer.ultimo().text) });
    return { solicitudId, numero, correo, token: sesion.body.token as string };
  }

  const lista = async (t: string) =>
    (await request(e.app).get(`${pub}/caracterizacion/documentos`).set(bearer(t))).body as {
      editable: boolean;
      documentosEditables: number[] | null;
      documentos: DocumentoPrueba[];
    };

  const subir = (t: string, docId: number, contenido: Buffer, nombre: string) =>
    request(e.app)
      .post(`${pub}/caracterizacion/documentos/${docId}`)
      .set(bearer(t))
      .attach('archivo', contenido, nombre);

  async function caracterizar(t: string, cuidador = true) {
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
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  async function cargarTodos(t: string) {
    for (const d of (await lista(t)).documentos.filter((x) => x.obligatorio)) {
      const r = await subir(t, d.id, pdf(d.codigo), `${d.codigo}.pdf`);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }
  }

  /** Una solicitud completa y radicada, lista para validar. */
  async function solicitudRadicada(
    opciones: { nombre?: string; cuidador?: boolean; correo?: string } = {},
  ) {
    const p = await persona(opciones);
    await caracterizar(p.token, opciones.cuidador ?? true);
    await cargarTodos(p.token);
    const r = await request(e.app)
      .post(`${pub}/caracterizacion/radicar`)
      .set(bearer(p.token))
      .send();
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await e.servicios.correos.esperarDespachos();
    return { ...p, radicado: r.body.radicado as string };
  }

  return { persona, caracterizar, cargarTodos, solicitudRadicada, lista, subir };
}
