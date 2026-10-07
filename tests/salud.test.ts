import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearEntorno, type Entorno } from './helpers.js';

describe('salud del servicio', () => {
  let e: Entorno;
  beforeAll(async () => {
    e = await crearEntorno();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('GET /api/v1/health confirma servicio y base de datos', async () => {
    const r = await request(e.app).get('/api/v1/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estado: 'ok', baseDeDatos: 'ok' });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('una ruta inexistente responde con el formato de error estándar', async () => {
    const r = await request(e.app).get('/api/v1/no-existe');
    expect(r.status).toBe(404);
    expect(r.body.error.codigo).toBe('RUTA_NO_ENCONTRADA');
  });

  it('sirve la documentación OpenAPI', async () => {
    const r = await request(e.app).get('/api/docs/openapi.json');
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe('3.0.3');
  });
});
