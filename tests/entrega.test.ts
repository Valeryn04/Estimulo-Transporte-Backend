import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  enmascararTarjeta,
  estadoTrasEntrega,
  normalizarTarjeta,
  rolesPendientes,
} from '../src/domain/entrega.js';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';
import { ayudantesSolicitud, bearer, pdf } from './solicitudes.js';

const adm = '/api/v1/admin';
const pub = '/api/v1/publico';

describe('reglas de la entrega', () => {
  it('enmascara el identificador de la tarjeta dejando visibles solo los últimos caracteres', () => {
    expect(enmascararTarjeta('TM00004821')).toBe('******4821');
    expect(enmascararTarjeta('AB12')).toBe('***2');
    expect(normalizarTarjeta(' tm 0004-821 ')).toBe('TM0004-821');
  });

  it('el beneficio pasa a activo o a pendiente de activación solo cuando todas las personas recibieron su tarjeta', () => {
    expect(rolesPendientes(2, ['PCD'])).toEqual(['CUIDADOR']);
    expect(rolesPendientes(1, ['PCD'])).toEqual([]);
    expect(rolesPendientes(2, [])).toEqual(['PCD', 'CUIDADOR']);
    expect(estadoTrasEntrega(1, true)).toBe('PENDIENTE_ENTREGA');
    expect(estadoTrasEntrega(0, true)).toBe('ACTIVO');
    expect(estadoTrasEntrega(0, false)).toBe('PENDIENTE_ACTIVACION');
  });
});

describe('entrega del medio de transporte y activación (RF-ASI-05, RF-ASI-06)', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let validador: CuentaPrueba;
  let asignador: CuentaPrueba;
  let analista: CuentaPrueba;

  type Caso = Awaited<ReturnType<typeof ay.validada>>;
  let casoA: Caso; // con cuidador
  let casoB: Caso; // sin cuidador
  let casoC: Caso;
  let beneficioA: number;
  let beneficioB: number;
  let beneficioC: number;
  let transporte: number;
  let cedula: number;

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    asignador = await crearCuenta(e, 'ASIGNADOR');
    analista = await crearCuenta(e, 'ANALISTA');
    await e.pool.query(
      `UPDATE vigencias SET cupos_totales = 5, valor_estimulo = 500000, presupuesto_total = 10000000 WHERE activa`,
    );
    casoA = await ay.validada(validador, {}, { correo: 'entrega.a@correo.com' });
    casoB = await ay.validada(validador, {}, { correo: 'entrega.b@correo.com', cuidador: false });
    casoC = await ay.validada(validador, {}, { correo: 'entrega.c@correo.com' });
    const r = await request(e.app)
      .post(`${adm}/asignacion/asignar`)
      .set(auth(asignador))
      .send({ solicitudIds: [casoA.solicitudId, casoB.solicitudId, casoC.solicitudId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = async (c: Caso) =>
      Number(
        (
          await e.pool.query<{ id: string }>(`SELECT id FROM beneficios WHERE solicitud_id = $1`, [
            c.solicitudId,
          ])
        ).rows[0]!.id,
      );
    beneficioA = await id(casoA);
    beneficioB = await id(casoB);
    beneficioC = await id(casoC);
    transporte = (
      await e.pool.query<{ id: number }>(
        `SELECT id FROM catalogo_items WHERE catalogo = 'TIPO_TRANSPORTE' ORDER BY id LIMIT 1`,
      )
    ).rows[0]!.id;
    cedula = (
      await e.pool.query<{ id: number }>(
        `SELECT id FROM catalogo_items WHERE catalogo = 'TIPO_IDENTIFICACION' AND codigo = 'CC'`,
      )
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
  const get = (c: CuentaPrueba, ruta: string) =>
    request(e.app).get(`${adm}/asignacion${ruta}`).set(auth(c));
  const entrega = (
    c: CuentaPrueba,
    beneficio: number,
    datos: Record<string, unknown>,
    conActa = true,
  ) => {
    const r = request(e.app)
      .post(`${adm}/asignacion/beneficiarios/${beneficio}/entregas`)
      .set(auth(c))
      .field('datos', JSON.stringify(datos));
    return conActa ? r.attach('archivo', pdf('acta'), 'acta-firmada.pdf') : r;
  };
  const base = (extra: Record<string, unknown> = {}) => ({
    rol: 'PCD',
    tarjetaId: 'TM00001234',
    tipoTransporteId: transporte,
    fechaEntrega: hoy(),
    receptorTipo: 'PCD',
    funcionarioEntrega: 'Funcionaria de entrega',
    ...extra,
  });
  const estadoDe = async (id: number) =>
    (await e.pool.query<{ estado: string }>(`SELECT estado FROM beneficios WHERE id = $1`, [id]))
      .rows[0]!.estado;
  const correosDeEntrega = async () => {
    await e.servicios.correos.esperarDespachos();
    return e.mailer.enviados.filter((m) => m.subject.includes('entrega de su medio de transporte'));
  };

  it('cada rol hace solo lo suyo: consultar, registrar y activar', async () => {
    expect((await get(analista, `/beneficiarios/${beneficioA}`)).status).toBe(200);
    expect((await get(validador, `/beneficiarios/${beneficioA}`)).status).toBe(403);
    expect((await entrega(analista, beneficioA, base())).status).toBe(403);
    expect((await entrega(validador, beneficioA, base())).status).toBe(403);
    expect(
      (
        await request(e.app)
          .post(`${adm}/asignacion/beneficiarios/${beneficioA}/activar`)
          .set(auth(analista))
      ).status,
    ).toBe(403);
    expect((await get(analista, '/beneficiarios/99999')).status).toBe(404);
  });

  it('el detalle trae las personas del beneficio, lo que falta entregar y las listas para el formulario', async () => {
    const d = (await get(asignador, `/beneficiarios/${beneficioA}`)).body;
    expect(d.beneficio).toMatchObject({
      radicado: casoA.radicado,
      estado: 'PENDIENTE_ENTREGA',
      personas: 2,
    });
    expect(d.personas.map((p: { rol: string }) => p.rol)).toEqual(['PCD', 'CUIDADOR']);
    expect(d.pendientes).toEqual(['PCD', 'CUIDADOR']);
    expect(d.opciones.tiposTransporte.length).toBeGreaterThan(0);
    expect(d.opciones.tiposIdentificacion.length).toBeGreaterThan(0);
    const b = (await get(asignador, `/beneficiarios/${beneficioB}`)).body;
    expect(b.pendientes).toEqual(['PCD']);
  });

  it('valida el acta, el identificador, las fechas, el tipo de transporte y el receptor', async () => {
    const campos = async (r: request.Response) =>
      (r.body.error?.errores ?? []).map((x: { campo: string }) => x.campo);
    expect(await campos(await entrega(asignador, beneficioA, base(), false))).toContain('archivo');
    expect(await campos(await entrega(asignador, beneficioA, base({ tarjetaId: 'ab' })))).toContain(
      'tarjetaId',
    );
    expect(
      await campos(await entrega(asignador, beneficioA, base({ tarjetaId: 'tm 12#4' }))),
    ).toContain('tarjetaId');
    const manana = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(
      await campos(await entrega(asignador, beneficioA, base({ fechaEntrega: manana }))),
    ).toContain('fechaEntrega');
    expect(
      await campos(await entrega(asignador, beneficioA, base({ fechaEntrega: '2020-01-01' }))),
    ).toContain('fechaEntrega');
    expect(
      await campos(await entrega(asignador, beneficioA, base({ tipoTransporteId: 999999 }))),
    ).toContain('tipoTransporteId');
    expect(
      await campos(await entrega(asignador, beneficioA, base({ funcionarioEntrega: 'x' }))),
    ).toContain('funcionarioEntrega');
    const tercero = await entrega(asignador, beneficioA, base({ receptorTipo: 'TERCERO' }));
    expect(tercero.status).toBe(422);
    expect(await campos(tercero)).toEqual(
      expect.arrayContaining(['receptorNombre', 'receptorTipoIdentificacionId', 'receptorNumero']),
    );
    // El beneficio sin cuidador no tiene tarjeta para el cuidador.
    const sinCuidador = await entrega(asignador, beneficioB, base({ rol: 'CUIDADOR' }));
    expect(sinCuidador.status).toBe(422);
    expect(await campos(sinCuidador)).toContain('rol');
    expect(
      await campos(await entrega(asignador, beneficioB, base({ receptorTipo: 'CUIDADOR' }))),
    ).toContain('receptorTipo');
    expect((await entrega(asignador, 99999, base())).status).toBe(404);
    expect(await estadoDe(beneficioA)).toBe('PENDIENTE_ENTREGA');
    const sinJson = await request(e.app)
      .post(`${adm}/asignacion/beneficiarios/${beneficioA}/entregas`)
      .set(auth(asignador))
      .attach('archivo', pdf(), 'a.pdf');
    expect(sinJson.status).toBe(422);
    const noPdf = await request(e.app)
      .post(`${adm}/asignacion/beneficiarios/${beneficioA}/entregas`)
      .set(auth(asignador))
      .field('datos', JSON.stringify(base()))
      .attach('archivo', Buffer.from('texto plano'), 'acta.pdf');
    expect(noPdf.status).toBe(422);
  });

  it('registra la entrega a la persona con discapacidad con todos sus datos; el beneficio sigue pendiente hasta que el cuidador reciba la suya', async () => {
    const r = await entrega(asignador, beneficioA, base());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.estado).toBe('PENDIENTE_ENTREGA');
    expect(r.body.pendientes).toEqual(['CUIDADOR']);
    const reg = r.body.entregas[0];
    expect(reg).toMatchObject({
      rol: 'PCD',
      tarjeta: '******1234',
      fechaEntrega: hoy(),
      receptorTipo: 'PCD',
      funcionarioEntrega: 'Funcionaria de entrega',
      registradoPor: asignador.usuario,
      soporte: { nombre: 'acta-firmada.pdf' },
    });
    // Quien recibe es la propia persona: nombre e identificación salen de su registro, no de lo que se escriba.
    expect(reg.receptorNombre).toBe('María Fernanda Pérez');
    expect(reg.receptorNumero).toBe(casoA.numero);
    // El identificador completo no sale de la base de datos hacia la API.
    expect(JSON.stringify(r.body)).not.toContain('TM00001234');
    const acta = await get(analista, `/entregas/${reg.id}/soporte`);
    expect(acta.status).toBe(200);
    expect(acta.headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(acta.body).toString('latin1')).toContain('%PDF');
    // Se notifica a la persona con los datos de la entrega, las recomendaciones y las causales de revocatoria (RF-ASI-06).
    const correos = await correosDeEntrega();
    expect(correos).toHaveLength(1);
    expect(correos[0]!.to).toBe('entrega.a@correo.com');
    expect(correos[0]!.text).toContain('******1234');
    expect(correos[0]!.text).not.toContain('TM00001234');
    expect(correos[0]!.text).toContain('Fecha de entrega:');
    expect(correos[0]!.text).toContain('Tipo de transporte:');
    expect(correos[0]!.text).toContain('intransferible');
    expect(correos[0]!.text).toContain('Uso indebido');
    expect(correos[0]!.text).toContain('Inactividad injustificada');
    expect(correos[0]!.text).toMatch(/consulta\?token=/);
    const bit = await e.pool.query(
      `SELECT usuario_id, valor_nuevo, detalle FROM bitacora WHERE accion = 'ENTREGA_REGISTRADA'`,
    );
    expect(bit.rows).toHaveLength(1);
    expect(bit.rows[0].usuario_id).toBe(asignador.id);
    expect(JSON.stringify(bit.rows[0])).not.toContain('TM00001234');
  });

  it('a la misma persona no se le registra dos veces la entrega, y una tarjeta no puede estar en dos beneficios vigentes', async () => {
    const otra = await entrega(asignador, beneficioA, base({ tarjetaId: 'TM00009999' }));
    expect(otra.status).toBe(409);
    expect(otra.body.error.codigo).toBe('ENTREGA_YA_REGISTRADA');
    const repetida = await entrega(asignador, beneficioB, base());
    expect(repetida.status).toBe(409);
    expect(repetida.body.error.codigo).toBe('TARJETA_EN_USO');
    // También lo garantiza la base de datos.
    await expect(
      e.pool.query(
        `INSERT INTO entregas (beneficio_id, rol, tarjeta_id, tipo_transporte_id, fecha_entrega, receptor_tipo,
                               receptor_nombre, funcionario_entrega, soporte_ruta, soporte_nombre, soporte_mime,
                               soporte_tamano, soporte_sha256, registrado_por)
         VALUES ($1, 'PCD', 'TM00001234', $2, CURRENT_DATE, 'PCD', 'Otra persona', 'Funcionario', 'x', 'x', 'x', 1, 'x', $3)`,
        [beneficioB, transporte, asignador.id],
      ),
    ).rejects.toBeDefined();
    expect(await estadoDe(beneficioB)).toBe('PENDIENTE_ENTREGA');
  });

  it('la tarjeta puede recibirla un tercero autorizado, con su identificación; con todas las entregas queda pendiente de activación', async () => {
    const r = await entrega(
      asignador,
      beneficioA,
      base({
        rol: 'CUIDADOR',
        tarjetaId: 'TM00005678',
        receptorTipo: 'TERCERO',
        receptorNombre: 'Ana Gómez Vargas',
        receptorTipoIdentificacionId: cedula,
        receptorNumero: '1.234.567-8',
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.estado).toBe('PENDIENTE_ACTIVACION');
    expect(r.body.pendientes).toEqual([]);
    const reg = r.body.entregas.find((x: { rol: string }) => x.rol === 'CUIDADOR');
    expect(reg).toMatchObject({
      receptorTipo: 'TERCERO',
      receptorNombre: 'Ana Gómez Vargas',
      receptorNumero: '12345678',
      receptorTipoIdentificacion: expect.any(String),
    });
    expect(await estadoDe(beneficioA)).toBe('PENDIENTE_ACTIVACION');
    expect((await correosDeEntrega()).length).toBe(2);
    // Ya no está pendiente de entrega.
    const mas = await entrega(
      asignador,
      beneficioA,
      base({ rol: 'CUIDADOR', tarjetaId: 'TM00007777' }),
    );
    expect(mas.status).toBe(409);
    expect(mas.body.error.codigo).toBe('BENEFICIO_NO_PENDIENTE');
    // La persona ve en su consulta en qué va su beneficio.
    const estado = await request(e.app).get(`${pub}/consulta/solicitud`).set(bearer(casoA.token));
    expect(estado.body.estado.nombre).toBe('Entregada, en activación');
    expect(estado.body.beneficio).toEqual({ codigo: 'PENDIENTE_ACTIVACION' });
  });

  it('la activación se confirma aparte, notifica a la persona y deja registro', async () => {
    const activar = (c: CuentaPrueba, id: number, cuerpo: object = {}) =>
      request(e.app)
        .post(`${adm}/asignacion/beneficiarios/${id}/activar`)
        .set(auth(c))
        .send(cuerpo);
    expect((await activar(analista, beneficioA)).status).toBe(403);
    // Un beneficio que aún espera su entrega no se activa.
    const pendiente = await activar(asignador, beneficioC);
    expect(pendiente.status).toBe(409);
    expect(pendiente.body.error.codigo).toBe('BENEFICIO_NO_PENDIENTE_ACTIVACION');
    const r = await activar(asignador, beneficioA, { observacion: 'Confirmado por Transmetro' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.beneficio).toMatchObject({ estado: 'ACTIVO' });
    expect(r.body.beneficio.activadoAt).not.toBeNull();
    await e.servicios.correos.esperarDespachos();
    const correo = e.mailer.enviados
      .filter((m) => m.subject.includes('beneficio está activo'))
      .at(-1)!;
    expect(correo.to).toBe('entrega.a@correo.com');
    const bit = await e.pool.query(
      `SELECT usuario_id, justificacion FROM bitacora WHERE accion = 'BENEFICIO_ACTIVADO'`,
    );
    expect(bit.rows[0]).toMatchObject({
      usuario_id: asignador.id,
      justificacion: 'Confirmado por Transmetro',
    });
    expect((await activar(asignador, beneficioA)).status).toBe(409);
    const estado = await request(e.app).get(`${pub}/consulta/solicitud`).set(bearer(casoA.token));
    expect(estado.body.estado.nombre).toBe('Beneficio activo');
    const lista = (await get(analista, '/beneficiarios?estado=ACTIVO')).body.items;
    expect(lista.map((b: { radicado: string }) => b.radicado)).toEqual([casoA.radicado]);
    expect(lista[0].entregas).toBe(2);
  });

  it('si el procedimiento activa al entregar, el beneficio queda activo de una vez', async () => {
    await e.pool.query(
      `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('entrega_activacion_inmediata', 'true', 'prueba')`,
    );
    const r = await entrega(
      asignador,
      beneficioB,
      base({ tarjetaId: 'TM00002468', receptorTipo: 'PCD' }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.estado).toBe('ACTIVO');
    expect(await estadoDe(beneficioB)).toBe('ACTIVO');
    expect(
      (await e.pool.query(`SELECT activado_at FROM beneficios WHERE id = $1`, [beneficioB])).rows[0]
        .activado_at,
    ).not.toBeNull();
  });

  it('el registro de la entrega no se modifica, y al finalizar el beneficio la tarjeta queda libre', async () => {
    await expect(
      e.pool.query(`UPDATE entregas SET tarjeta_id = 'TM99999999'`),
    ).rejects.toBeDefined();
    await expect(e.pool.query(`DELETE FROM entregas`)).rejects.toBeDefined();
    // El beneficio A renuncia: su cupo se libera y sus tarjetas quedan disponibles.
    await e.servicios.asignacion.liberarCupo(
      e.pool,
      asignador.id,
      beneficioA,
      'Renuncia del beneficiario',
      {
        ip: null,
      },
    );
    const libres = await e.pool.query(`SELECT vigente FROM entregas WHERE beneficio_id = $1`, [
      beneficioA,
    ]);
    expect(libres.rows.map((x) => x.vigente)).toEqual([false, false]);
    const reutilizada = await entrega(asignador, beneficioC, base({ tarjetaId: 'TM00001234' }));
    expect(reutilizada.status, JSON.stringify(reutilizada.body)).toBe(201);
    expect(reutilizada.body.entregas[0].tarjeta).toBe('******1234');
    const estado = await request(e.app).get(`${pub}/consulta/solicitud`).set(bearer(casoA.token));
    expect(estado.body.estado.nombre).toBe('Beneficio finalizado');
  });
});
