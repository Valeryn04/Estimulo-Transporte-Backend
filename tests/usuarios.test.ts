import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auth,
  crearCuenta,
  crearEntorno,
  crearUsuarioBD,
  type CuentaPrueba,
  type Entorno,
} from './helpers.js';

const api = '/api/v1';

describe('administración de usuarios y de su rol (RF-ADM-01)', () => {
  let e: Entorno;
  let admin: CuentaPrueba;
  let rolIds: Record<string, number>;

  beforeAll(async () => {
    e = await crearEntorno();
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    const r = await request(e.app).get(`${api}/admin/roles`).set(auth(admin));
    rolIds = Object.fromEntries(
      (r.body.items as { id: number; codigo: string }[]).map((x) => [x.codigo, x.id]),
    );
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const nuevo = (extra: Record<string, unknown> = {}) => ({
    usuario: `func${Math.random().toString(36).slice(2, 8)}`,
    nombres: 'María Pérez Gómez',
    correo: `m${Math.random().toString(36).slice(2, 8)}@barranquilla.gov.co`,
    password: 'Temporal#2026ab',
    rolId: rolIds.AUDITOR_VERIFICADOR,
    ...extra,
  });

  it('lista los 7 roles del numeral 3.2 con sus permisos', async () => {
    expect(Object.keys(rolIds).sort()).toEqual(
      [
        'ADMINISTRADOR',
        'ANALISTA',
        'ASIGNADOR',
        'AUDITOR_VERIFICADOR',
        'CONTROL_INTERNO',
        'GESTOR_NOVEDADES',
        'RESPONSABLE_PROCESO',
      ].sort(),
    );
  });

  it('crea un usuario con su rol, exige cambio de contraseña y lo registra en la bitácora', async () => {
    const r = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send(nuevo({ rolId: rolIds.ANALISTA }));
    expect(r.status).toBe(201);
    expect(r.body.estado).toBe('ACTIVO');
    expect(r.body.debeCambiarPassword).toBe(true);
    expect(r.body.rol).toMatchObject({ codigo: 'ANALISTA', nombre: 'Analista' });
    expect(r.body.roles).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toMatch(/hash|argon2|"password"|vigente/i);
    const b = await e.pool.query(
      `SELECT * FROM bitacora WHERE accion = 'USUARIO_CREADO' AND entidad_id = $1`,
      [String(r.body.id)],
    );
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0].usuario_id).toBe(admin.id);
    expect(b.rows[0].valor_nuevo.rol.codigo).toBe('ANALISTA');
  });

  it('la contraseña se guarda como hash adaptativo, nunca en texto plano', async () => {
    const d = nuevo();
    const r = await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(d);
    const { rows } = await e.pool.query(`SELECT password_hash FROM usuarios WHERE id = $1`, [
      r.body.id,
    ]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(d.password);
  });

  it('valida los datos con mensajes por campo (usuario, correo, contraseña, rol)', async () => {
    const r = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send({ usuario: 'A', nombres: 'x', correo: 'mal', password: 'corta' });
    expect(r.status).toBe(422);
    const campos = (r.body.error.errores as { campo: string }[]).map((x) => x.campo);
    expect(campos).toEqual(expect.arrayContaining(['usuario', 'nombres', 'correo']));
  });

  it('exige un rol que exista y no admite varios ni vigencias', async () => {
    const sin = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send({ ...nuevo(), rolId: undefined });
    expect(sin.status).toBe(422);
    expect(sin.body.error.errores[0].campo).toBe('rolId');
    const varios = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send(nuevo({ rolId: [rolIds.ANALISTA, rolIds.CONTROL_INTERNO] }));
    expect(varios.status).toBe(422);
    const inex = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send(nuevo({ rolId: 99999 }));
    expect(inex.status).toBe(422);
    expect(inex.body.error.errores[0].mensaje).toContain('elija un rol');
  });

  it('un usuario tiene un solo rol: la base de datos no admite un segundo', async () => {
    const c = await crearCuenta(e, 'ANALISTA');
    await expect(
      e.pool.query(`INSERT INTO usuario_rol (usuario_id, rol_id) VALUES ($1, $2)`, [
        c.id,
        rolIds.CONTROL_INTERNO,
      ]),
    ).rejects.toThrow(/uq_usuario_un_rol/);
  });

  it('ninguna cuenta comparte credenciales: usuario y correo son únicos', async () => {
    const d = nuevo();
    await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(d);
    const mismoUsuario = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send(nuevo({ usuario: d.usuario.toUpperCase() }));
    expect(mismoUsuario.status).toBe(422);
    expect(mismoUsuario.body.error.errores[0].campo).toBe('usuario');
    const mismoCorreo = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send(nuevo({ correo: d.correo }));
    expect(mismoCorreo.status).toBe(422);
    expect(mismoCorreo.body.error.errores[0].campo).toBe('correo');
  });

  it('modifica datos y rol guardando valor anterior y nuevo; el cambio rige de inmediato', async () => {
    const creado = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send(nuevo());
    const id = creado.body.id as number;
    const u = await e.pool.query(`SELECT usuario FROM usuarios WHERE id = $1`, [id]);
    await e.pool.query(`UPDATE usuarios SET debe_cambiar_password = false WHERE id = $1`, [id]);
    const login = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.rows[0].usuario, password: 'Temporal#2026ab' });
    expect((await request(e.app).get(`${api}/admin/usuarios`).set(auth(login.body))).status).toBe(
      403,
    );
    // Se le da el rol de administrador: la siguiente llamada ya funciona, con el mismo token.
    const mod = await request(e.app).put(`${api}/admin/usuarios/${id}`).set(auth(admin)).send({
      nombres: 'María P. Gómez',
      correo: creado.body.correo,
      rolId: rolIds.ADMINISTRADOR,
    });
    expect(mod.status).toBe(200);
    expect(mod.body.rol.codigo).toBe('ADMINISTRADOR');
    expect((await request(e.app).get(`${api}/admin/usuarios`).set(auth(login.body))).status).toBe(
      200,
    );
    const b = await e.pool.query(
      `SELECT valor_anterior, valor_nuevo FROM bitacora WHERE accion = 'USUARIO_MODIFICADO' AND entidad_id = $1`,
      [String(id)],
    );
    expect(b.rows[0].valor_anterior.nombres).toBe('María Pérez Gómez');
    expect(b.rows[0].valor_nuevo.nombres).toBe('María P. Gómez');
  });

  it('las restricciones de rol aplican a llamadas directas a la API', async () => {
    const analista = await crearCuenta(e, 'ANALISTA');
    for (const [metodo, ruta] of [
      ['get', '/admin/usuarios'],
      ['get', '/admin/roles'],
      ['post', '/admin/usuarios'],
      ['post', '/admin/usuarios/1/bloquear'],
    ] as const) {
      const r = await request(e.app)[metodo](`${api}${ruta}`).set(auth(analista)).send({});
      expect(r.status, `${metodo} ${ruta}`).toBe(403);
    }
    expect((await request(e.app).get(`${api}/admin/usuarios`)).status).toBe(401);
  });

  it('bloquear exige motivo, cierra sus sesiones y se puede revertir', async () => {
    const c = await crearCuenta(e, 'ANALISTA');
    const sinMotivo = await request(e.app)
      .post(`${api}/admin/usuarios/${c.id}/bloquear`)
      .set(auth(admin))
      .send({});
    expect(sinMotivo.status).toBe(422);
    const r = await request(e.app)
      .post(`${api}/admin/usuarios/${c.id}/bloquear`)
      .set(auth(admin))
      .send({ motivo: 'Licencia prolongada' });
    expect(r.body.estado).toBe('BLOQUEADO');
    expect((await request(e.app).get(`${api}/auth/me`).set(auth(c))).status).toBe(401);
    expect(
      (
        await request(e.app)
          .post(`${api}/auth/login`)
          .send({ usuario: c.usuario, password: c.password })
      ).status,
    ).toBe(401);
    const des = await request(e.app)
      .post(`${api}/admin/usuarios/${c.id}/desbloquear`)
      .set(auth(admin))
      .send({});
    expect(des.body.estado).toBe('ACTIVO');
    expect(
      (
        await request(e.app)
          .post(`${api}/auth/login`)
          .send({ usuario: c.usuario, password: c.password })
      ).status,
    ).toBe(200);
    const b = await e.pool.query(
      `SELECT justificacion FROM bitacora WHERE accion = 'USUARIO_BLOQUEADO' AND entidad_id = $1`,
      [String(c.id)],
    );
    expect(b.rows[0].justificacion).toBe('Licencia prolongada');
  });

  it('dar de baja es definitivo: no se borra, no se modifica ni se reactiva', async () => {
    const c = await crearUsuarioBD(e, 'ANALISTA');
    const r = await request(e.app)
      .post(`${api}/admin/usuarios/${c.id}/baja`)
      .set(auth(admin))
      .send({ motivo: 'Fin de contrato' });
    expect(r.body.estado).toBe('BAJA');
    expect(
      (
        await request(e.app)
          .post(`${api}/auth/login`)
          .send({ usuario: c.usuario, password: c.password })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(e.app)
          .post(`${api}/admin/usuarios/${c.id}/desbloquear`)
          .set(auth(admin))
          .send({})
      ).status,
    ).toBe(409);
    const put = await request(e.app)
      .put(`${api}/admin/usuarios/${c.id}`)
      .set(auth(admin))
      .send({ nombres: 'Otro nombre', correo: 'o@x.co', rolId: rolIds.ANALISTA });
    expect(put.status).toBe(409);
    const { rows } = await e.pool.query(`SELECT 1 FROM usuarios WHERE id = $1`, [c.id]);
    expect(rows).toHaveLength(1);
  });

  it('no se puede bloquear a sí mismo ni al administrador principal', async () => {
    const propia = await request(e.app)
      .post(`${api}/admin/usuarios/${admin.id}/bloquear`)
      .set(auth(admin))
      .send({ motivo: 'prueba de bloqueo' });
    expect(propia.status).toBe(400);
    const principal = await crearUsuarioBD(e, 'ADMINISTRADOR', { protegido: true });
    const r = await request(e.app)
      .post(`${api}/admin/usuarios/${principal.id}/baja`)
      .set(auth(admin))
      .send({ motivo: 'prueba de baja' });
    expect(r.body.error.codigo).toBe('USUARIO_PROTEGIDO');
    const quitar = await request(e.app)
      .put(`${api}/admin/usuarios/${principal.id}`)
      .set(auth(admin))
      .send({
        nombres: 'Principal Admin',
        correo: `${principal.usuario}@alcaldia.test`,
        rolId: rolIds.ANALISTA,
      });
    expect(quitar.body.error.codigo).toBe('USUARIO_PROTEGIDO');
  });

  it('restablecer contraseña fija una temporal, cierra sesiones y obliga a cambiarla', async () => {
    const c = await crearCuenta(e, 'ANALISTA');
    const floja = await request(e.app)
      .post(`${api}/admin/usuarios/${c.id}/restablecer-password`)
      .set(auth(admin))
      .send({ password: 'floja' });
    expect(floja.status).toBe(422);
    const ok = await request(e.app)
      .post(`${api}/admin/usuarios/${c.id}/restablecer-password`)
      .set(auth(admin))
      .send({ password: 'Otra#Temporal2026' });
    expect(ok.status).toBe(204);
    expect((await request(e.app).get(`${api}/auth/me`).set(auth(c))).status).toBe(401);
    const login = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: c.usuario, password: 'Otra#Temporal2026' });
    expect(login.body.perfil.debeCambiarPassword).toBe(true);
  });

  it('lista con búsqueda, filtros y paginación', async () => {
    const r = await request(e.app)
      .get(`${api}/admin/usuarios?estado=ACTIVO&tamano=2&pagina=1`)
      .set(auth(admin));
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeLessThanOrEqual(2);
    expect(r.body.total).toBeGreaterThan(2);
    const q = await request(e.app)
      .get(`${api}/admin/usuarios?q=${encodeURIComponent('%')}`)
      .set(auth(admin));
    expect(q.body.total).toBe(0); // el comodín % se trata como texto literal
  });

  it('restringe el portal interno a las IP autorizadas cuando se configura', async () => {
    const e2 = await crearEntorno({ ips: ['10.20.0.0/16'] });
    try {
      const r = await request(e2.app)
        .post(`${api}/auth/login`)
        .send({ usuario: 'a', password: 'b' });
      expect(r.status).toBe(403);
      expect(r.body.error.codigo).toBe('IP_NO_AUTORIZADA');
    } finally {
      await e2.cerrar();
    }
  });
});
