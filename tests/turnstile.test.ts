import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CloudflareTurnstile,
  TurnstileDesactivado,
  crearTurnstile,
  exigirTurnstile,
  type VerificadorTurnstile,
} from '../src/infrastructure/security/turnstile.js';
import { crearAplicacion } from '../src/presentation/http/app.js';
import { manejadorErrores } from '../src/presentation/http/middlewares/errores.js';
import { crearEntorno, type Entorno } from './helpers.js';

const respuesta = (cuerpo: unknown, ok = true) =>
  Promise.resolve({ ok, json: () => Promise.resolve(cuerpo) } as Response);

describe('CloudflareTurnstile', () => {
  it('envía el secreto, el token y la IP, y acepta solo success=true', async () => {
    let enviado: URLSearchParams | undefined;
    const peticion = ((_url: string, init: RequestInit) => {
      enviado = init.body as URLSearchParams;
      return respuesta({ success: true });
    }) as unknown as typeof fetch;
    const v = new CloudflareTurnstile('sitio', 'secreto', peticion);
    expect(await v.verificar('tok', '10.0.0.1')).toBe(true);
    expect(enviado?.get('secret')).toBe('secreto');
    expect(enviado?.get('response')).toBe('tok');
    expect(enviado?.get('remoteip')).toBe('10.0.0.1');
  });

  it('rechaza si Cloudflare lo rechaza, responde error o no responde', async () => {
    const con = (f: () => Promise<Response>) =>
      new CloudflareTurnstile('s', 'k', f as unknown as typeof fetch);
    expect(await con(() => respuesta({ success: false })).verificar('t', null)).toBe(false);
    expect(await con(() => respuesta({}, false)).verificar('t', null)).toBe(false);
    expect(await con(() => Promise.reject(new Error('sin red'))).verificar('t', null)).toBe(false);
  });

  it('sin llaves queda desactivado', async () => {
    const v = crearTurnstile(null);
    expect(v).toBeInstanceOf(TurnstileDesactivado);
    expect(v.activo).toBe(false);
    expect(crearTurnstile({ siteKey: 'a', secret: 'b' }).activo).toBe(true);
  });
});

describe('exigirTurnstile', () => {
  const falso = (valido: string): VerificadorTurnstile => ({
    activo: true,
    siteKey: 'sitio',
    verificar: (t) => Promise.resolve(t === valido),
  });
  const app = (v: VerificadorTurnstile) => {
    const a = express();
    a.post('/x', exigirTurnstile(v), (_req, res) => {
      res.json({ ok: true });
    });
    a.use(manejadorErrores);
    return a;
  };

  it('pasa con un token válido', async () => {
    const r = await request(app(falso('bueno')))
      .post('/x')
      .set('X-Turnstile-Token', 'bueno');
    expect(r.status).toBe(200);
  });

  it('rechaza sin token o con un token inválido', async () => {
    const sin = await request(app(falso('bueno'))).post('/x');
    expect(sin.status).toBe(422);
    expect(sin.body.error.codigo).toBe('VERIFICACION_ROBOT');
    const mal = await request(app(falso('bueno')))
      .post('/x')
      .set('X-Turnstile-Token', 'malo');
    expect(mal.status).toBe(422);
  });

  it('desactivado no pide nada', async () => {
    const r = await request(app(new TurnstileDesactivado())).post('/x');
    expect(r.status).toBe(200);
  });
});

describe('Turnstile en la API', () => {
  let e: Entorno;
  let app: ReturnType<typeof crearAplicacion>['app'];
  beforeAll(async () => {
    e = await crearEntorno();
    const verificador: VerificadorTurnstile = {
      activo: true,
      siteKey: 'sitio-publico',
      verificar: (t) => Promise.resolve(t === 'bueno'),
    };
    app = crearAplicacion({ ...e.deps, turnstile: verificador }, { limitarIntentos: false }).app;
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('publica la llave del sitio y nada más', async () => {
    const r = await request(app).get('/api/v1/publico/config');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ turnstileSiteKey: 'sitio-publico' });
    const sin = await request(e.app).get('/api/v1/publico/config');
    expect(sin.body).toEqual({ turnstileSiteKey: null });
  });

  it('el formulario, el código de consulta y el inicio de sesión lo exigen', async () => {
    for (const ruta of [
      '/api/v1/publico/preinscripciones',
      '/api/v1/publico/preinscripciones/reenviar-verificacion',
      '/api/v1/publico/consulta/solicitar-codigo',
      '/api/v1/auth/login',
    ]) {
      const sin = await request(app).post(ruta).send({});
      expect(sin.status, ruta).toBe(422);
      expect(sin.body.error.codigo, ruta).toBe('VERIFICACION_ROBOT');
      // Con el token válido la petición sigue y falla por su propia validación, no por el robot.
      const con = await request(app).post(ruta).set('X-Turnstile-Token', 'bueno').send({});
      expect(con.body.error?.codigo, ruta).not.toBe('VERIFICACION_ROBOT');
    }
  });

  it('las consultas que no abren un proceso no lo exigen', async () => {
    const r = await request(app).get('/api/v1/publico/preinscripcion/formulario');
    expect(r.status).toBe(200);
  });
});
