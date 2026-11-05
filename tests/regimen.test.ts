import request from 'supertest';
import { loadEnv } from '../src/config/env.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  RegimenHttp,
  RegimenSimulado as RegimenSimuladoReal,
  crearConsultaRegimen,
  type ConsultaRegimen,
  type ResultadoRegimen,
} from '../src/infrastructure/bdua/regimen.js';
import { RegimenSimulado, crearEntorno, type Entorno } from './helpers.js';
import { ayudantesSolicitud, bearer, pdf } from './solicitudes.js';

const pub = '/api/v1/publico';

describe('cliente del servicio BDUA/ADRES', () => {
  const respuesta = (cuerpo: unknown, status = 200) =>
    (() => Promise.resolve(new Response(JSON.stringify(cuerpo), { status }))) as typeof fetch;

  it('manda el documento y el token en la cabecera y reconoce al subsidiado', async () => {
    let visto: { url: string; token: string | null } | null = null;
    const peticion = ((url: URL, init: RequestInit) => {
      visto = { url: String(url), token: new Headers(init.headers).get('x-access-token') };
      return Promise.resolve(
        new Response(
          JSON.stringify({
            codigo: 1,
            mensaje: 'La persona se encuentra en estado AC',
            subsidiado: 1,
          }),
        ),
      );
    }) as unknown as typeof fetch;
    const c = new RegimenHttp('https://servicio.test/v1/bdua/persona', 'secreto', peticion);
    expect(await c.consultar('CC', '123')).toEqual({
      estado: 'SUBSIDIADO',
      mensaje: 'La persona se encuentra en estado AC',
    });
    expect(visto).toEqual({
      url: 'https://servicio.test/v1/bdua/persona?tdoc=CC&doc=123',
      token: 'secreto',
    });
  });

  it('una persona que no es subsidiada o no está activa no pasa el filtro', async () => {
    const c = new RegimenHttp(
      'https://servicio.test/x',
      't',
      respuesta({ codigo: 1, mensaje: 'La persona no se encuentra en estado AC', subsidiado: 0 }),
    );
    expect((await c.consultar('TI', '9')).estado).toBe('NO_SUBSIDIADO');
  });

  it('si el servicio rechaza o falla, no se puede confirmar', async () => {
    const rechaza = new RegimenHttp('https://servicio.test/x', 't', respuesta('no', 403));
    expect((await rechaza.consultar('CC', '1')).estado).toBe('NO_DISPONIBLE');
    const cae = new RegimenHttp('https://servicio.test/x', 't', (() =>
      Promise.reject(new Error('red'))) as typeof fetch);
    expect((await cae.consultar('CC', '1')).estado).toBe('NO_DISPONIBLE');
  });
});

describe('filtro de régimen subsidiado en la caracterización', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let respuestaServicio: ResultadoRegimen;
  const llamadas: string[] = [];
  const falso: ConsultaRegimen = {
    activo: true,
    consultar: (tipo, numero) => {
      llamadas.push(`${tipo} ${numero}`);
      return Promise.resolve(respuestaServicio);
    },
  };

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    e.deps.regimen = falso;
  });
  afterAll(async () => {
    e.deps.regimen = new RegimenSimulado();
    await e.cerrar();
  });
  beforeEach(() => {
    llamadas.length = 0;
    respuestaServicio = {
      estado: 'SUBSIDIADO',
      mensaje: 'La persona se encuentra en estado AC',
    };
  });

  const regimen = (t: string) =>
    request(e.app).get(`${pub}/caracterizacion/regimen`).set(bearer(t));
  const afiliacion = async (t: string) =>
    (await ay.lista(t)).documentos.find((d) => d.codigo === 'PCD_AFILIACION_SUBSIDIADO')!;

  it('con el documento de la persona confirma que es subsidiada y adjunta sola la constancia', async () => {
    const p = await ay.persona();
    await ay.caracterizar(p.token);
    const r = await regimen(p.token);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.consulta).toMatchObject({ estado: 'SUBSIDIADO' });
    expect(llamadas).toEqual([`CC ${p.numero}`]);
    const d = await afiliacion(p.token);
    expect(d.estado).toBe('CARGADO');
    expect(d.automatico).toBe(true);
    expect(d.archivo?.nombre).toBe('constancia-regimen-subsidiado.pdf');
    // La constancia se puede descargar y no se vuelve a consultar.
    const bajar = await request(e.app)
      .get(`${pub}/caracterizacion/documentos/${d.id}/archivo`)
      .set(bearer(p.token));
    expect(bajar.status).toBe(200);
    expect(bajar.headers['content-type']).toContain('application/pdf');
    await regimen(p.token);
    expect(llamadas).toHaveLength(1);
  });

  it('ese soporte ya no se carga a mano', async () => {
    const p = await ay.persona();
    await ay.caracterizar(p.token);
    const d = await afiliacion(p.token);
    const r = await ay.subir(p.token, d.id, pdf('afiliacion'), 'afiliacion.pdf');
    expect(r.status).toBe(409);
    expect(r.body.error.codigo).toBe('DOCUMENTO_AUTOMATICO');
  });

  it('si no es subsidiada la solicitud no se puede enviar y se le explica por qué', async () => {
    respuestaServicio = {
      estado: 'NO_SUBSIDIADO',
      mensaje: 'La persona no se encuentra en estado AC',
    };
    const p = await ay.persona();
    await ay.caracterizar(p.token);
    await ay.cargarTodos(p.token);
    const r = await regimen(p.token);
    expect(r.body.consulta.estado).toBe('NO_SUBSIDIADO');
    const rev = (await request(e.app).get(`${pub}/caracterizacion/revision`).set(bearer(p.token)))
      .body;
    expect(rev.completo).toBe(false);
    expect(JSON.stringify(rev.documentos)).toContain('régimen subsidiado');
    const radicar = await request(e.app)
      .post(`${pub}/caracterizacion/radicar`)
      .set(bearer(p.token));
    expect(radicar.status).toBe(422);
  });

  it('si el servicio no responde pide intentar más tarde y vuelve a consultar al enviar', async () => {
    respuestaServicio = {
      estado: 'NO_DISPONIBLE',
      mensaje: 'El servicio de consulta no respondió.',
    };
    const p = await ay.persona();
    await ay.caracterizar(p.token);
    await ay.cargarTodos(p.token);
    await regimen(p.token);
    const rev = (await request(e.app).get(`${pub}/caracterizacion/revision`).set(bearer(p.token)))
      .body;
    expect(JSON.stringify(rev.documentos)).toContain('Intente de nuevo');
    // Vuelve el servicio: al enviar se consulta otra vez y la solicitud pasa.
    respuestaServicio = { estado: 'SUBSIDIADO', mensaje: 'La persona se encuentra en estado AC' };
    const radicar = await request(e.app)
      .post(`${pub}/caracterizacion/radicar`)
      .set(bearer(p.token));
    expect(radicar.status, JSON.stringify(radicar.body)).toBe(201);
    // El validador ve el resultado de la consulta en el caso.
    const consultas = await e.pool.query(
      `SELECT resultado FROM consultas_regimen WHERE solicitud_id = $1 ORDER BY id`,
      [p.solicitudId],
    );
    expect(consultas.rows.map((x) => x.resultado)).toEqual(['NO_DISPONIBLE', 'SUBSIDIADO']);
  });
});

describe('respuesta simulada del servicio (pruebas y muestras)', () => {
  it('responde subsidiado, salvo los documentos que se indiquen, y lo marca como simulado', async () => {
    const c = crearConsultaRegimen(null, { noSubsidiados: ['111'] });
    expect(await c.consultar('CC', '222')).toEqual({
      estado: 'SUBSIDIADO',
      mensaje: '(simulado) La persona se encuentra en estado AC',
    });
    expect((await c.consultar('CC', '111')).estado).toBe('NO_SUBSIDIADO');
  });

  it('la simulación tiene prioridad sobre el servicio real, y no se permite en producción', () => {
    const base = {
      NODE_ENV: 'test',
      BDUA_URL: 'https://servicio.test/x',
      BDUA_TOKEN: 't',
      BDUA_SIMULAR: 'true',
    };
    expect(crearConsultaRegimen({ url: 'u', token: 't' }, { noSubsidiados: [] })).toBeInstanceOf(
      RegimenSimuladoReal,
    );
    expect(() => loadEnv({ ...process.env, ...base, NODE_ENV: 'production' })).toThrow();
    expect(loadEnv({ ...process.env, ...base }).bduaSimulado).toEqual({ noSubsidiados: [] });
  });
});
