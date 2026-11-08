import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validarPassword } from '../src/domain/passwords.js';
import { ErrorEnvioCorreo } from '../src/infrastructure/mail/mailer.js';
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
    // Estas pruebas crean usuarios con los roles individuales: se activa ese modo (por defecto los roles están unidos).
    await e.pool.query(
      `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('roles_individuales', 'true', 'prueba')`,
    );
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
    rolId: rolIds.AUDITOR_VERIFICADOR,
    ...extra,
  });

  /** La contraseña temporal solo existe en el correo que recibe la persona: se lee del último correo enviado. */
  const contrasenaDelCorreo = async () => {
    await e.servicios.correos.esperarDespachos();
    const m = /contraseña temporal es:\s+(\S+)/.exec(e.mailer.ultimo().text);
    expect(m, 'el correo debe traer la contraseña temporal').not.toBeNull();
    // El correo lleva solo la contraseña: nunca el usuario.
    expect(e.mailer.ultimo().text).not.toMatch(/Usuario:/);
    expect(e.mailer.ultimo().html).toContain(
      ((m as RegExpExecArray)[1] as string)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;'),
    );
    return (m as RegExpExecArray)[1] as string;
  };

  it('avisa antes de crear si el usuario o el correo ya los usa otra cuenta', async () => {
    const d = nuevo();
    const creado = await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(d);
    const consulta = (q: string) =>
      request(e.app).get(`${api}/admin/usuarios/disponibilidad?${q}`).set(auth(admin));
    const ocupado = await consulta(
      `usuario=${d.usuario.toUpperCase()}&correo=${encodeURIComponent(d.correo.toUpperCase())}`,
    );
    expect(ocupado.status).toBe(200);
    expect(ocupado.body.usuario).toEqual({ disponible: false });
    expect(ocupado.body.correo).toEqual({ disponible: false });
    // Nunca se revela qué cuenta lo usa.
    expect(JSON.stringify(ocupado.body)).not.toContain(d.usuario);
    const libre = await consulta('usuario=nadie.lo.usa&correo=libre%40barranquilla.gov.co');
    expect(libre.body.usuario).toEqual({ disponible: true });
    expect(libre.body.correo).toEqual({ disponible: true });
    // Al editar a esa misma persona, su propio correo no cuenta como ocupado.
    const propio = await consulta(
      `correo=${encodeURIComponent(d.correo)}&excluirId=${creado.body.id}`,
    );
    expect(propio.body.correo.disponible).toBe(true);
    // Solo quien administra usuarios lo consulta.
    const analista = await crearCuenta(e, 'ANALISTA');
    expect(
      (
        await request(e.app)
          .get(`${api}/admin/usuarios/disponibilidad?correo=a%40b.co`)
          .set(auth(analista))
      ).status,
    ).toBe(403);
  });

  it('lista los roles del sistema: los 7 individuales y los 2 unidos', async () => {
    expect(Object.keys(rolIds).sort()).toEqual(
      [
        'ADMINISTRADOR',
        'ANALISTA',
        'ASIGNADOR',
        'AUDITOR_VERIFICADOR',
        'CONTROL_INTERNO',
        'GESTOR_NOVEDADES',
        'OPERATIVO',
        'RESPONSABLE_PROCESO',
        'SEGUIMIENTO',
      ].sort(),
    );
  });

  describe('roles unidos o individuales', () => {
    const modo = (individuales: boolean) =>
      e.pool.query(
        `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('roles_individuales', $1, 'prueba')`,
        [String(individuales)],
      );
    const ofrecidos = async () =>
      (
        (await request(e.app).get(`${api}/admin/roles`).set(auth(admin))).body.items as {
          codigo: string;
          ofrecido: boolean;
        }[]
      )
        .filter((r) => r.ofrecido)
        .map((r) => r.codigo)
        .sort();
    const crear = (rolId: number) =>
      request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(nuevo({ rolId }));

    afterAll(async () => {
      await modo(true);
    });

    it('por defecto se ofrecen los roles unidos y no los individuales', async () => {
      await modo(false);
      expect(await ofrecidos()).toEqual(
        ['ADMINISTRADOR', 'OPERATIVO', 'RESPONSABLE_PROCESO', 'SEGUIMIENTO'].sort(),
      );
      const individual = await crear(rolIds.AUDITOR_VERIFICADOR!);
      expect(individual.status).toBe(422);
      expect(individual.body.error.errores[0].campo).toBe('rolId');
      expect(individual.body.error.errores[0].mensaje).toContain('estén unidos');
      const unido = await crear(rolIds.OPERATIVO!);
      expect(unido.status, JSON.stringify(unido.body)).toBe(201);
      expect(unido.body.rol.codigo).toBe('OPERATIVO');
    });

    it('el rol unido Operativo reúne los permisos de validar, priorizar, asignar y novedades', async () => {
      const roles = (await request(e.app).get(`${api}/admin/roles`).set(auth(admin))).body
        .items as { codigo: string; permisos: string[] }[];
      const de = (c: string) => roles.find((r) => r.codigo === c)!.permisos;
      for (const individual of ['AUDITOR_VERIFICADOR', 'ASIGNADOR', 'GESTOR_NOVEDADES']) {
        expect(de('OPERATIVO')).toEqual(expect.arrayContaining(de(individual)));
      }
      for (const individual of ['ANALISTA', 'CONTROL_INTERNO']) {
        expect(de('SEGUIMIENTO')).toEqual(expect.arrayContaining(de(individual)));
      }
    });

    it('al activar los roles individuales se ofrecen esos y quien ya tiene un rol unido lo conserva', async () => {
      await modo(false);
      const existente = await crear(rolIds.OPERATIVO!);
      expect(existente.status).toBe(201);
      await modo(true);
      expect(await ofrecidos()).toEqual(
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
      expect((await crear(rolIds.OPERATIVO!)).status).toBe(422);
      expect((await crear(rolIds.ASIGNADOR!)).status).toBe(201);
      // Editar a quien ya tiene el rol unido (sin cambiárselo) sigue funcionando.
      const editar = await request(e.app)
        .put(`${api}/admin/usuarios/${existente.body.id}`)
        .set(auth(admin))
        .send({
          nombres: 'Nombre Corregido',
          correo: existente.body.correo,
          rolId: rolIds.OPERATIVO,
        });
      expect(editar.status, JSON.stringify(editar.body)).toBe(200);
    });
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

  it('la contraseña temporal la genera el sistema, llega por correo y no queda en claro en la base', async () => {
    const d = nuevo({ rolId: rolIds.ANALISTA });
    const r = await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(d);
    expect(r.status).toBe(201);
    const temporal = await contrasenaDelCorreo();
    const correo = e.mailer.ultimo();
    expect(correo.to).toBe(d.correo);
    // El correo lleva solo la contraseña, no el usuario.
    expect(correo.text).not.toContain(d.usuario);
    expect(correo.text).toContain('/interno/login');
    // Cumple la política de contraseñas y no se parece al usuario.
    expect(validarPassword(temporal, d.usuario)).toEqual([]);
    // Nada en la respuesta de la API ni en la base de datos (texto del correo, bitácora, secretos) la contiene.
    expect(JSON.stringify(r.body)).not.toContain(temporal);
    const guardado = await e.pool.query(
      `SELECT cuerpo, secretos FROM correos WHERE destinatario = $1 AND tipo = 'CUENTA_CREADA'`,
      [d.correo],
    );
    expect(guardado.rows).toHaveLength(1);
    expect(guardado.rows[0].cuerpo).not.toContain(temporal);
    expect(guardado.rows[0].cuerpo).toContain('[contraseña temporal]');
    expect(guardado.rows[0].secretos).toBeNull(); // se borra al salir el correo
    const bitacora = await e.pool.query(`SELECT valor_nuevo FROM bitacora WHERE entidad_id = $1`, [
      String(r.body.id),
    ]);
    expect(JSON.stringify(bitacora.rows)).not.toContain(temporal);
    // Con esa contraseña entra, y el sistema le obliga a cambiarla.
    const login = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: d.usuario, password: temporal });
    expect(login.status).toBe(200);
    expect(login.body.perfil.debeCambiarPassword).toBe(true);
  });

  it('cada contraseña temporal es distinta y la API ignora una que escriba el administrador', async () => {
    const a = nuevo();
    const b = nuevo();
    await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(a);
    const pa = await contrasenaDelCorreo();
    await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(b);
    const pb = await contrasenaDelCorreo();
    expect(pa).not.toBe(pb);
    const c = nuevo();
    await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send({ ...c, password: 'Escrita#Por1Admin' });
    const pc = await contrasenaDelCorreo();
    expect(pc).not.toBe('Escrita#Por1Admin');
    const intento = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: c.usuario, password: 'Escrita#Por1Admin' });
    expect(intento.status).toBe(401);
  });

  it('si el correo no sale a la primera, la contraseña sigue cifrada y sale en el reintento', async () => {
    e.mailer.falla = new ErrorEnvioCorreo('servidor caído', false);
    const d = nuevo();
    const r = await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(d);
    expect(r.status).toBe(201);
    await e.servicios.correos.esperarDespachos();
    const pendiente = await e.pool.query(
      `SELECT cuerpo, secretos, estado FROM correos WHERE destinatario = $1`,
      [d.correo],
    );
    expect(pendiente.rows[0].estado).toBe('PENDIENTE');
    expect(pendiente.rows[0].secretos).not.toBeNull();
    expect(pendiente.rows[0].cuerpo).toContain('[contraseña temporal]');
    // Vuelve el servicio de correo: el reintento envía la contraseña real y limpia el secreto.
    e.mailer.falla = null;
    await e.pool.query(`UPDATE correos SET proximo_intento_at = now() WHERE destinatario = $1`, [
      d.correo,
    ]);
    await e.servicios.correos.procesarPendientes();
    const temporal = /contraseña temporal es:\s+(\S+)/.exec(e.mailer.ultimo().text)?.[1] as string;
    expect(temporal).toBeTruthy();
    expect(temporal).not.toContain('[');
    const fin = await e.pool.query(`SELECT secretos, estado FROM correos WHERE destinatario = $1`, [
      d.correo,
    ]);
    expect(fin.rows[0]).toMatchObject({ estado: 'ENVIADO', secretos: null });
  });

  it('la contraseña se guarda como hash adaptativo, nunca en texto plano', async () => {
    const d = nuevo();
    const r = await request(e.app).post(`${api}/admin/usuarios`).set(auth(admin)).send(d);
    const temporal = await contrasenaDelCorreo();
    const { rows } = await e.pool.query(`SELECT password_hash FROM usuarios WHERE id = $1`, [
      r.body.id,
    ]);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(rows[0].password_hash).not.toContain(temporal);
  });

  it('valida los datos con mensajes por campo (usuario, correo, contraseña, rol)', async () => {
    const r = await request(e.app)
      .post(`${api}/admin/usuarios`)
      .set(auth(admin))
      .send({ usuario: 'A', nombres: 'x', correo: 'mal' });
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
    const temporal = await contrasenaDelCorreo();
    const u = await e.pool.query(`SELECT usuario FROM usuarios WHERE id = $1`, [id]);
    await e.pool.query(`UPDATE usuarios SET debe_cambiar_password = false WHERE id = $1`, [id]);
    const login = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: u.rows[0].usuario, password: temporal });
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

  it('restablecer contraseña genera una temporal nueva, la envía por correo, cierra sesiones y obliga a cambiarla', async () => {
    const c = await crearCuenta(e, 'ANALISTA');
    const ok = await request(e.app)
      .post(`${api}/admin/usuarios/${c.id}/restablecer-password`)
      .set(auth(admin));
    expect(ok.status).toBe(204);
    expect(ok.text).toBe('');
    const temporal = await contrasenaDelCorreo();
    expect(e.mailer.ultimo().subject).toContain('restablecida');
    const guardado = await e.pool.query(
      `SELECT cuerpo, secretos FROM correos WHERE tipo = 'PASSWORD_RESTABLECIDA' ORDER BY id DESC LIMIT 1`,
    );
    expect(guardado.rows[0].cuerpo).not.toContain(temporal);
    expect(guardado.rows[0].secretos).toBeNull();
    expect((await request(e.app).get(`${api}/auth/me`).set(auth(c))).status).toBe(401);
    // La anterior ya no sirve; la nueva sí y pide cambiarla.
    const vieja = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: c.usuario, password: c.password });
    expect(vieja.status).toBe(401);
    const login = await request(e.app)
      .post(`${api}/auth/login`)
      .send({ usuario: c.usuario, password: temporal });
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
