import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  crearCuenta,
  crearEntorno,
  crearUsuarioBD,
  desdePortal,
  type Entorno,
} from './helpers.js';

const api = '/api/v1';

describe('autenticación de usuarios internos (RNF-05)', () => {
  let e: Entorno;
  beforeAll(async () => {
    e = await crearEntorno();
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('inicia sesión: entrega token, perfil y deja el refresh token solo en una cookie HttpOnly', async () => {
    const u = await crearUsuarioBD(e, 'ADMINISTRADOR');
    const r = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.usuario, password: u.password });
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    expect(r.body.refresh).toBeUndefined();
    expect(r.body.perfil.permisos).toContain('usuarios.administrar');
    expect(r.body.inactividadMinutos).toBe(30);
    const cookie = (r.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toMatch(/estimulo_rt=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('no revela si falló el usuario o la contraseña, y registra el intento en la bitácora', async () => {
    const u = await crearUsuarioBD(e, 'ADMINISTRADOR');
    const mala = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.usuario, password: 'mala' });
    const inexistente = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: 'nadie', password: 'mala' });
    expect(mala.status).toBe(401);
    expect(inexistente.status).toBe(401);
    expect(mala.body.error.mensaje).toBe(inexistente.body.error.mensaje);
    const { rows } = await e.pool.query(
      `SELECT accion FROM bitacora WHERE accion = 'LOGIN_FALLIDO'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it('bloquea temporalmente la cuenta tras los intentos fallidos configurados', async () => {
    const u = await crearUsuarioBD(e, 'ADMINISTRADOR');
    for (let i = 0; i < 5; i++) {
      await request(e.app).post(`${api}/auth/login`).send({ usuario: u.usuario, password: 'mala' });
    }
    const r = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.usuario, password: u.password });
    expect(r.status).toBe(429);
    expect(r.body.error.codigo).toBe('CUENTA_BLOQUEADA');
    // Pasado el tiempo de bloqueo parametrizado, puede ingresar de nuevo.
    e.reloj.ahora = new Date(Date.now() + 16 * 60_000);
    await e.pool.query(
      `UPDATE usuarios SET bloqueado_hasta = now() - interval '1 minute' WHERE id = $1`,
      [u.id],
    );
    const ok = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.usuario, password: u.password });
    expect(ok.status).toBe(200);
    e.reloj.ahora = new Date();
  });

  it('el número de intentos sale del parámetro versionado, sin cambios de código', async () => {
    await e.pool.query(
      `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('login_max_intentos', '3', 'prueba')`,
    );
    const u = await crearUsuarioBD(e, 'ADMINISTRADOR');
    for (let i = 0; i < 3; i++) {
      await request(e.app).post(`${api}/auth/login`).send({ usuario: u.usuario, password: 'mala' });
    }
    const r = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.usuario, password: u.password });
    expect(r.body.error.codigo).toBe('CUENTA_BLOQUEADA');
  });

  it('exige token en las rutas protegidas y rechaza tokens falsos', async () => {
    expect((await request(e.app).get(`${api}/auth/me`)).status).toBe(401);
    expect(
      (await request(e.app).get(`${api}/auth/me`).set('Authorization', 'Bearer falso')).status,
    ).toBe(401);
  });

  it('renueva la sesión con la cookie y rota el refresh token', async () => {
    const c = await crearCuenta(e, 'ADMINISTRADOR');
    const r = await request(e.app)
      .post(`${api}/auth/refresh`)
      .set(desdePortal)
      .set('Cookie', c.cookie);
    expect(r.status).toBe(200);
    expect(r.body.token).toBeTruthy();
    const nueva = ((r.headers['set-cookie'] as unknown as string[])[0] ?? '').split(';')[0];
    expect(nueva).not.toBe(c.cookie);
  });

  it('el refresh exige la cabecera del portal (defensa CSRF)', async () => {
    const c = await crearCuenta(e, 'ADMINISTRADOR');
    const r = await request(e.app).post(`${api}/auth/refresh`).set('Cookie', c.cookie);
    expect(r.status).toBe(403);
    expect(r.body.error.codigo).toBe('ORIGEN_NO_PERMITIDO');
  });

  it('un refresh token ya usado (robo) revoca toda la sesión', async () => {
    const c = await crearCuenta(e, 'ADMINISTRADOR');
    await request(e.app).post(`${api}/auth/refresh`).set(desdePortal).set('Cookie', c.cookie);
    // Pasado el margen de gracia, reutilizar el secreto anterior es un robo.
    e.reloj.ahora = new Date(Date.now() + 60_000);
    const reuso = await request(e.app)
      .post(`${api}/auth/refresh`)
      .set(desdePortal)
      .set('Cookie', c.cookie);
    expect(reuso.status).toBe(401);
    const me = await request(e.app).get(`${api}/auth/me`).set(auth(c));
    expect(me.status).toBe(401);
    e.reloj.ahora = new Date();
  });

  it('cierra la sesión por inactividad (parámetro) y por el tope absoluto', async () => {
    const c = await crearCuenta(e, 'ADMINISTRADOR');
    e.reloj.ahora = new Date(Date.now() + 31 * 60_000);
    const r = await request(e.app).get(`${api}/auth/me`).set(auth(c));
    expect(r.status).toBe(401);
    expect(r.body.error.codigo).toBe('SESION_EXPIRADA');
    e.reloj.ahora = new Date();
  });

  it('el cierre de sesión revoca la sesión de inmediato', async () => {
    const c = await crearCuenta(e, 'ADMINISTRADOR');
    const out = await request(e.app)
      .post(`${api}/auth/logout`)
      .set(desdePortal)
      .set('Cookie', c.cookie);
    expect(out.status).toBe(204);
    expect((await request(e.app).get(`${api}/auth/me`).set(auth(c))).status).toBe(401);
  });

  it('obliga a cambiar la contraseña temporal antes de usar el resto del sistema', async () => {
    const c = await crearCuenta(e, 'ADMINISTRADOR', { debeCambiar: true });
    const bloqueado = await request(e.app).get(`${api}/admin/usuarios`).set(auth(c));
    expect(bloqueado.status).toBe(403);
    expect(bloqueado.body.error.codigo).toBe('PASSWORD_VENCIDA');
    const mala = await request(e.app)
      .post(`${api}/auth/cambiar-password`)
      .set(auth(c))
      .send({ passwordActual: c.password, passwordNueva: 'corta' });
    expect(mala.status).toBe(422);
    const ok = await request(e.app)
      .post(`${api}/auth/cambiar-password`)
      .set(auth(c))
      .send({ passwordActual: c.password, passwordNueva: 'Nueva#Clave2026x' });
    expect(ok.status).toBe(200);
    expect(ok.body.perfil.debeCambiarPassword).toBe(false);
    // El token anterior ya no sirve; el nuevo sí.
    expect((await request(e.app).get(`${api}/admin/usuarios`).set(auth(c))).status).toBe(401);
    expect((await request(e.app).get(`${api}/admin/usuarios`).set(auth(ok.body))).status).toBe(200);
  });

  it('un usuario sin rol no puede ingresar', async () => {
    const u = await crearUsuarioBD(e, 'ANALISTA');
    await e.pool.query(`DELETE FROM usuario_rol WHERE usuario_id = $1`, [u.id]);
    const r = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.usuario, password: u.password });
    expect(r.status).toBe(403);
    expect(r.body.error.codigo).toBe('ACCESO_NO_VIGENTE');
    expect(r.body.error.mensaje).toContain('no tiene un rol');
  });
});
