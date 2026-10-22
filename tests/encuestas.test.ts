import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  erroresDePreguntas,
  indicadorSatisfaccion,
  resumirResultados,
  validarRespuestas,
  type PreguntaEncuesta,
} from '../src/domain/encuestas.js';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';
import { ayudantesSolicitud } from './solicitudes.js';

const adm = '/api/v1/admin';
const pub = '/api/v1/publico';

const PREGUNTAS: PreguntaEncuesta[] = [
  {
    id: 1,
    tipo: 'ESCALA',
    texto: '¿Qué tan satisfecho está?',
    obligatoria: true,
    opciones: null,
    escalaMax: 5,
  },
  {
    id: 2,
    tipo: 'SELECCION',
    texto: '¿Con qué frecuencia lo usa?',
    obligatoria: true,
    opciones: ['Diario', 'Semanal'],
    escalaMax: null,
  },
  {
    id: 3,
    tipo: 'TEXTO',
    texto: '¿Algún comentario?',
    obligatoria: false,
    opciones: null,
    escalaMax: null,
  },
];

describe('reglas de las encuestas', () => {
  it('revisa las preguntas: al menos una, selección con dos opciones distintas y escala entre 3 y 10', () => {
    expect(erroresDePreguntas([])).toHaveLength(1);
    const malas = erroresDePreguntas([
      {
        tipo: 'SELECCION',
        texto: 'Una pregunta',
        obligatoria: true,
        opciones: ['Sí'],
        escalaMax: null,
      },
      {
        tipo: 'SELECCION',
        texto: 'Otra pregunta',
        obligatoria: true,
        opciones: ['Sí', 'sí'],
        escalaMax: null,
      },
      { tipo: 'ESCALA', texto: 'Escala corta', obligatoria: true, opciones: null, escalaMax: 2 },
      { tipo: 'TEXTO', texto: 'ab', obligatoria: false, opciones: null, escalaMax: null },
    ]);
    expect(malas.map((m) => m.mensaje)).toEqual([
      expect.stringContaining('Pregunta 1: agregue al menos dos opciones'),
      expect.stringContaining('Pregunta 2: hay opciones repetidas'),
      expect.stringContaining('Pregunta 3: la escala'),
      expect.stringContaining('Pregunta 4: escriba el texto'),
    ]);
  });

  it('valida las respuestas por tipo y exige las obligatorias', () => {
    const ok = validarRespuestas(PREGUNTAS, { '1': 4, '2': 'Diario', '3': '  Muy bien  ' });
    expect(ok.errores).toEqual([]);
    expect(ok.respuestas).toEqual({ '1': 4, '2': 'Diario', '3': 'Muy bien' });
    const mal = validarRespuestas(PREGUNTAS, { '1': 9, '2': 'Nunca' });
    expect(mal.errores.map((e) => e.campo)).toEqual(['1', '2']);
    expect(validarRespuestas(PREGUNTAS, {}).errores.map((e) => e.campo)).toEqual(['1', '2']);
  });

  it('resume sin identificar y calcula el indicador de satisfacción de 0 a 100', () => {
    const todas = [
      { '1': 5, '2': 'Diario', '3': 'Excelente' },
      { '1': 3, '2': 'Semanal' },
      { '1': 1, '2': 'Diario' },
    ];
    const r = resumirResultados(PREGUNTAS, todas);
    expect(r[0]).toMatchObject({ respondidas: 3, promedio: 3 });
    expect(r[0]!.conteo?.find((c) => c.valor === '5')?.cantidad).toBe(1);
    expect(r[1]!.conteo).toEqual([
      { valor: 'Diario', cantidad: 2 },
      { valor: 'Semanal', cantidad: 1 },
    ]);
    expect(r[2]!.textos).toEqual(['Excelente']);
    // (100 + 50 + 0) / 3
    expect(indicadorSatisfaccion(PREGUNTAS, todas)).toBe(50);
    expect(indicadorSatisfaccion(PREGUNTAS, [])).toBeNull();
  });
});

describe('encuestas de satisfacción (RF-NOV-04)', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let admin: CuentaPrueba;
  let analista: CuentaPrueba;
  let validador: CuentaPrueba;
  let asignador: CuentaPrueba;

  const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);
  const enDias = (n: number) =>
    new Date(Date.now() - 5 * 3_600_000 + n * 86_400_000).toISOString().slice(0, 10);
  const encuesta = (extra: Record<string, unknown> = {}) => ({
    titulo: 'Satisfacción con el servicio',
    descripcion: 'Queremos conocer su experiencia',
    desde: hoy(),
    hasta: enDias(30),
    preguntas: [
      {
        tipo: 'ESCALA',
        texto: '¿Qué tan satisfecho está con el servicio?',
        obligatoria: true,
        escalaMax: 5,
      },
      {
        tipo: 'SELECCION',
        texto: '¿Con qué frecuencia usa la tarjeta?',
        obligatoria: true,
        opciones: ['Todos los días', 'Una vez por semana'],
      },
      { tipo: 'TEXTO', texto: '¿Qué mejoraría del servicio?', obligatoria: false },
    ],
    ...extra,
  });
  const campos = (r: request.Response) =>
    (r.body.error?.errores ?? []).map((x: { campo: string }) => x.campo);
  const api = (c: CuentaPrueba, ruta = '') =>
    request(e.app).get(`${adm}/encuestas${ruta}`).set(auth(c));
  const crear = (c: CuentaPrueba, cuerpo: object) =>
    request(e.app).post(`${adm}/encuestas`).set(auth(c)).send(cuerpo);
  const accion = (c: CuentaPrueba, id: number, a: string) =>
    request(e.app).post(`${adm}/encuestas/${id}/${a}`).set(auth(c)).send();

  let id: number;
  let tokenA = '';
  let tokenB = '';
  let preguntas: { id: number; tipo: string }[] = [];

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    analista = await crearCuenta(e, 'ANALISTA');
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    asignador = await crearCuenta(e, 'ASIGNADOR');
    await e.pool.query(
      `UPDATE vigencias SET cupos_totales = 10, valor_estimulo = 500000, presupuesto_total = 50000000 WHERE activa`,
    );
    const casos = [
      await ay.validada(validador, {}, { correo: 'enc.a@correo.com' }),
      await ay.validada(validador, {}, { correo: 'enc.b@correo.com' }),
      await ay.validada(validador, {}, { correo: 'enc.c@correo.com' }),
    ];
    const r = await request(e.app)
      .post(`${adm}/asignacion/asignar`)
      .set(auth(asignador))
      .send({ solicitudIds: casos.map((c) => c.solicitudId) });
    expect(r.status).toBe(201);
    // Los dos primeros están activos; el tercero sigue pendiente de entrega.
    await e.pool.query(
      `UPDATE beneficios SET estado = 'ACTIVO', activado_at = now() WHERE solicitud_id = ANY($1::int[])`,
      [[casos[0]!.solicitudId, casos[1]!.solicitudId]],
    );
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('cada rol hace solo lo suyo', async () => {
    expect((await request(e.app).get(`${adm}/encuestas`)).status).toBe(401);
    expect((await api(validador)).status).toBe(403);
    expect((await api(analista)).status).toBe(200);
    expect((await crear(analista, encuesta())).status).toBe(403);
    expect((await api(analista, '/1')).status).toBe(403);
  });

  it('valida la encuesta y sus preguntas al crearla', async () => {
    expect(campos(await crear(admin, encuesta({ titulo: 'x' })))).toContain('titulo');
    const r = await crear(admin, encuesta({ preguntas: [] }));
    expect(r.status).toBe(422);
    expect(campos(r)).toContain('preguntas');
    expect(campos(await crear(admin, encuesta({ hasta: '2020-01-01' })))).toContain('hasta');
    const sel = await crear(
      admin,
      encuesta({ preguntas: [{ tipo: 'SELECCION', texto: 'Una sola opción', opciones: ['Sí'] }] }),
    );
    expect(sel.status).toBe(422);
    expect(sel.body.error.errores[0].mensaje).toContain('dos opciones');
    expect(
      campos(
        await crear(admin, encuesta({ preguntas: [{ tipo: 'RARO', texto: 'Pregunta rara' }] })),
      ),
    ).toContain('preguntas.0.tipo');
  });

  it('crea la encuesta en borrador con preguntas de selección, escala y texto, y la modifica mientras es borrador', async () => {
    const r = await crear(admin, encuesta());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    id = r.body.id;
    expect(r.body).toMatchObject({ estado: 'BORRADOR', invitadas: 0 });
    expect(r.body.preguntas.map((p: { tipo: string }) => p.tipo)).toEqual([
      'ESCALA',
      'SELECCION',
      'TEXTO',
    ]);
    const mod = await request(e.app)
      .put(`${adm}/encuestas/${id}`)
      .set(auth(admin))
      .send(encuesta({ titulo: 'Satisfacción con el servicio 2026' }));
    expect(mod.body.titulo).toBe('Satisfacción con el servicio 2026');
    expect(
      (await request(e.app).put(`${adm}/encuestas/99999`).set(auth(admin)).send(encuesta())).status,
    ).toBe(404);
    preguntas = (await api(admin, `/${id}`)).body.preguntas;
  });

  it('al publicar invita por correo solo a los beneficiarios activos, y ya no se puede modificar', async () => {
    const vacia = await crear(admin, encuesta({ titulo: 'Sin publicar todavía' }));
    expect((await accion(analista, id, 'publicar')).status).toBe(403);
    expect((await accion(admin, 99999, 'publicar')).status).toBe(404);
    expect((await accion(admin, id, 'cerrar')).status).toBe(409);
    const r = await accion(admin, id, 'publicar');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ estado: 'PUBLICADA', invitadas: 2, invitadosAhora: 2 });
    await e.servicios.correos.esperarDespachos();
    const mails = e.mailer.enviados.filter((m) =>
      m.subject.includes('Queremos conocer su opinión'),
    );
    expect(mails.map((m) => m.to).sort()).toEqual(['enc.a@correo.com', 'enc.b@correo.com']);
    expect(mails[0]!.text).toContain('Satisfacción con el servicio 2026');
    expect(mails[0]!.text).toContain('anónima');
    const token = (m: { text: string }) => /encuesta\?token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
    tokenA = token(mails.find((m) => m.to === 'enc.a@correo.com')!);
    tokenB = token(mails.find((m) => m.to === 'enc.b@correo.com')!);
    expect(tokenA).not.toBe(tokenB);
    // El token no se guarda: solo su huella.
    expect(
      (await e.pool.query(`SELECT 1 FROM encuesta_invitaciones WHERE token_hash = $1`, [tokenA]))
        .rowCount,
    ).toBe(0);
    // Quienes consultan los resultados se enteran de la publicación; quien valida casos, no.
    const avisosDe = async (c: CuentaPrueba) =>
      (await request(e.app).get(`${adm}/alertas`).set(auth(c))).body.items as { tipo: string }[];
    expect((await avisosDe(analista)).some((x) => x.tipo === 'ENCUESTA_PUBLICADA')).toBe(true);
    expect((await avisosDe(validador)).some((x) => x.tipo === 'ENCUESTA_PUBLICADA')).toBe(false);
    expect((await accion(admin, id, 'publicar')).status).toBe(409);
    expect(
      (await request(e.app).put(`${adm}/encuestas/${id}`).set(auth(admin)).send(encuesta())).body
        .error.codigo,
    ).toBe('ENCUESTA_NO_EDITABLE');
    await expect(
      e.pool.query(
        `UPDATE encuesta_preguntas SET texto = 'cambiada por sql' WHERE encuesta_id = $1`,
        [id],
      ),
    ).rejects.toBeDefined();
    // Una encuesta sin preguntas no se publica.
    const sinPreguntas = await e.pool.query(
      `INSERT INTO encuestas (titulo, vigente_desde, vigente_hasta, creada_por) VALUES ('Sin preguntas', CURRENT_DATE, CURRENT_DATE + 5, $1) RETURNING id`,
      [admin.id],
    );
    const p = await accion(admin, sinPreguntas.rows[0].id, 'publicar');
    expect(p.status).toBe(422);
    expect(vacia.status).toBe(201);
  });

  it('la persona ve la encuesta con su enlace personal y los enlaces inválidos no sirven', async () => {
    const r = await request(e.app).get(`${pub}/encuesta`).query({ token: tokenA });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.titulo).toBe('Satisfacción con el servicio 2026');
    expect(r.body.preguntas.map((p: { tipo: string }) => p.tipo)).toEqual([
      'ESCALA',
      'SELECCION',
      'TEXTO',
    ]);
    expect(JSON.stringify(r.body)).not.toContain('enc.a@correo.com');
    const mal = await request(e.app)
      .get(`${pub}/encuesta`)
      .query({ token: 'x'.repeat(43) });
    expect(mal.status).toBe(404);
    expect((await request(e.app).get(`${pub}/encuesta`).query({ token: 'corto' })).status).toBe(
      422,
    );
  });

  it('valida las respuestas, guarda una sola por beneficiario y no deja rastro de quién respondió', async () => {
    const q = (t: string, r: object) =>
      request(e.app).post(`${pub}/encuesta/responder`).send({ token: t, respuestas: r });
    const [escala, seleccion, texto] = preguntas;
    const faltan = await q(tokenA, {});
    expect(faltan.status).toBe(422);
    expect(campos(faltan)).toEqual([String(escala!.id), String(seleccion!.id)]);
    expect((await q(tokenA, { [escala!.id]: 9, [seleccion!.id]: 'Todos los días' })).status).toBe(
      422,
    );
    expect((await q(tokenA, { [escala!.id]: 4, [seleccion!.id]: 'Nunca' })).status).toBe(422);
    const ok = await q(tokenA, {
      [escala!.id]: 4,
      [seleccion!.id]: 'Todos los días',
      [texto!.id]: 'Más rutas hacia el norte',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const otra = await q(tokenA, { [escala!.id]: 5, [seleccion!.id]: 'Todos los días' });
    expect(otra.status).toBe(409);
    expect(otra.body.error.codigo).toBe('ENCUESTA_YA_RESPONDIDA');
    expect((await request(e.app).get(`${pub}/encuesta`).query({ token: tokenA })).status).toBe(409);
    // Separación de identidad y respuestas: la tabla de respuestas no referencia al beneficiario ni a la invitación.
    const cols = await e.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'encuesta_respuestas'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual([
      'dia',
      'encuesta_id',
      'id',
      'localidad_id',
      'respuestas',
    ]);
    const bit = await e.pool.query(
      `SELECT usuario_id, solicitud_id FROM bitacora WHERE accion = 'ENCUESTA_RESPONDIDA'`,
    );
    expect(bit.rows).toEqual([{ usuario_id: null, solicitud_id: null }]);
    await expect(
      e.pool.query(`UPDATE encuesta_respuestas SET respuestas = '{}'`),
    ).rejects.toBeDefined();
    await expect(e.pool.query(`DELETE FROM encuesta_respuestas`)).rejects.toBeDefined();
  });

  it('los resultados se analizan de forma anonimizada, con la tasa de respuesta y el indicador de satisfacción', async () => {
    const [escala, seleccion, texto] = preguntas;
    expect(
      (
        await request(e.app)
          .post(`${pub}/encuesta/responder`)
          .send({
            token: tokenB,
            respuestas: { [escala!.id]: 2, [seleccion!.id]: 'Una vez por semana' },
          })
      ).status,
    ).toBe(201);
    const r = (await api(analista, `/${id}/resultados`)).body;
    expect(r).toMatchObject({ invitadas: 2, respondidas: 2, tasaRespuesta: 100 });
    // (75 + 25) / 2
    expect(r.satisfaccion).toBe(50);
    const pe = r.preguntas.find((p: { id: number }) => p.id === escala!.id);
    expect(pe).toMatchObject({ respondidas: 2, promedio: 3 });
    const ps = r.preguntas.find((p: { id: number }) => p.id === seleccion!.id);
    expect(ps.conteo).toEqual([
      { valor: 'Todos los días', cantidad: 1 },
      { valor: 'Una vez por semana', cantidad: 1 },
    ]);
    expect(r.preguntas.find((p: { id: number }) => p.id === texto!.id).textos).toEqual([
      'Más rutas hacia el norte',
    ]);
    const json = JSON.stringify(r);
    expect(json).not.toContain('enc.a@correo.com');
    expect(json).not.toMatch(/EST-\d{4}-/);
    expect((await api(validador, `/${id}/resultados`)).status).toBe(403);
    expect((await api(analista, '/99999/resultados')).status).toBe(404);
  });

  it('cerrar la encuesta o vencer su periodo impide responder', async () => {
    const nueva = (await crear(admin, encuesta({ titulo: 'Segunda encuesta del periodo' }))).body
      .id as number;
    await accion(admin, nueva, 'publicar');
    await e.servicios.correos.esperarDespachos();
    const correo = e.mailer.enviados
      .filter((m) => m.subject.includes('Queremos conocer su opinión'))
      .at(-1)!;
    const token = /encuesta\?token=([A-Za-z0-9_-]+)/.exec(correo.text)![1]!;
    const cerrada = await accion(admin, nueva, 'cerrar');
    expect(cerrada.body.estado).toBe('CERRADA');
    const r = await request(e.app).get(`${pub}/encuesta`).query({ token });
    expect(r.status).toBe(409);
    expect(r.body.error.codigo).toBe('ENCUESTA_CERRADA');
    // Una encuesta publicada cuyo periodo ya pasó tampoco admite respuestas.
    await e.pool.query(
      `UPDATE encuestas SET vigente_desde = CURRENT_DATE - 10, vigente_hasta = CURRENT_DATE - 1 WHERE id = $1`,
      [id],
    );
    const [escala] = preguntas;
    const vencida = await request(e.app)
      .post(`${pub}/encuesta/responder`)
      .send({ token: tokenA, respuestas: { [escala!.id]: 3 } });
    expect(vencida.status).toBe(409);
    expect((await accion(admin, nueva, 'cerrar')).status).toBe(409);
    expect((await api(analista)).body.items.length).toBeGreaterThanOrEqual(3);
  });
});
