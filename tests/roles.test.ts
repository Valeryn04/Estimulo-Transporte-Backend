import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';

const api = '/api/v1/admin';

interface Rol {
  id: number;
  codigo: string;
  nombre: string;
  descripcion: string;
  sistema: boolean;
  permisos: string[];
  usuarios: number;
}

describe('roles y permisos (RF-ADM-01)', () => {
  let e: Entorno;
  let admin: CuentaPrueba;
  let contador = 0;

  beforeAll(async () => {
    e = await crearEntorno();
    admin = await crearCuenta(e, 'ADMINISTRADOR');
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const get = (ruta: string, c = admin) => request(e.app).get(`${api}${ruta}`).set(auth(c));
  const crear = (cuerpo: object = {}) =>
    request(e.app)
      .post(`${api}/roles`)
      .set(auth(admin))
      .send({
        nombre: `Rol de prueba ${++contador} ${Math.random().toString(36).slice(2, 6)}`,
        descripcion: 'Rol creado por una prueba automática',
        permisos: ['catalogos.administrar'],
        ...cuerpo,
      });
  const roles = async () => (await get('/roles')).body.items as Rol[];
  const porCodigo = async (codigo: string) => (await roles()).find((r) => r.codigo === codigo)!;

  describe('consulta', () => {
    it('lista los 7 roles del sistema con sus permisos y cuántos usuarios los tienen', async () => {
      const lista = await roles();
      const sistema = lista.filter((r) => r.sistema);
      expect(sistema.map((r) => r.codigo).sort()).toEqual([
        'ADMINISTRADOR',
        'ANALISTA',
        'ASIGNADOR',
        'AUDITOR_VERIFICADOR',
        'CONTROL_INTERNO',
        'GESTOR_NOVEDADES',
        'RESPONSABLE_PROCESO',
      ]);
      const administrador = sistema.find((r) => r.codigo === 'ADMINISTRADOR')!;
      expect(administrador.permisos).toEqual(
        expect.arrayContaining([
          'catalogos.administrar',
          'parametros.administrar',
          'plantillas.administrar',
          'usuarios.administrar',
        ]),
      );
      expect(administrador.usuarios).toBeGreaterThanOrEqual(1);
    });

    it('trae el catálogo de permisos con su módulo y descripción', async () => {
      const r = await get('/permisos');
      expect(r.status).toBe(200);
      const codigos = (r.body.items as { codigo: string }[]).map((p) => p.codigo);
      expect(codigos).toEqual(
        expect.arrayContaining(['usuarios.administrar', 'catalogos.administrar']),
      );
      expect(r.body.items[0]).toEqual(
        expect.objectContaining({ modulo: expect.any(String), descripcion: expect.any(String) }),
      );
    });

    it('solo quien administra usuarios ve y cambia los roles, también por la API directa', async () => {
      const analista = await crearCuenta(e, 'ANALISTA');
      for (const [metodo, ruta] of [
        ['get', '/roles'],
        ['get', '/permisos'],
        ['post', '/roles'],
        ['put', '/roles/1'],
        ['delete', '/roles/1'],
      ] as const) {
        const r = await request(e.app)[metodo](`${api}${ruta}`).set(auth(analista)).send({});
        expect(r.status, `${metodo} ${ruta}`).toBe(403);
      }
      expect((await request(e.app).get(`${api}/roles`)).status).toBe(401);
      expect((await request(e.app).delete(`${api}/roles/1`)).status).toBe(401);
    });
  });

  describe('crear un rol', () => {
    it('crea un rol propio con sus permisos, código automático y registro en la bitácora', async () => {
      const r = await crear({
        nombre: 'Coordinador de Área 2',
        permisos: ['catalogos.administrar', 'plantillas.administrar'],
      });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        codigo: 'COORDINADOR_DE_AREA_2',
        nombre: 'Coordinador de Área 2',
        sistema: false,
        usuarios: 0,
        permisos: ['catalogos.administrar', 'plantillas.administrar'],
      });
      const b = await e.pool.query(
        `SELECT usuario_id, valor_nuevo FROM bitacora WHERE accion = 'ROL_CREADO' AND entidad_id = $1`,
        [String(r.body.id)],
      );
      expect(b.rows[0].usuario_id).toBe(admin.id);
      expect(b.rows[0].valor_nuevo.permisos).toEqual([
        'catalogos.administrar',
        'plantillas.administrar',
      ]);
    });

    it('puede crearse sin permisos todavía y no repite permisos', async () => {
      const sin = await crear({ permisos: [] });
      expect(sin.status).toBe(201);
      expect(sin.body.permisos).toEqual([]);
      const repetidos = await crear({
        permisos: ['catalogos.administrar', 'catalogos.administrar'],
      });
      expect(repetidos.body.permisos).toEqual(['catalogos.administrar']);
    });

    it('no admite dos roles con el mismo nombre, aunque cambien mayúsculas, tildes de espacio o el rol sea del sistema', async () => {
      await crear({ nombre: 'Revisor Externo' });
      const igual = await crear({ nombre: '  revisor externo ' });
      expect(igual.status).toBe(422);
      expect(igual.body.error.errores[0].campo).toBe('nombre');
      const delSistema = await crear({ nombre: 'analista' });
      expect(delSistema.status).toBe(422);
    });

    it('valida el nombre, la descripción y que los permisos existan', async () => {
      const corto = await crear({ nombre: 'ab', descripcion: 'x' });
      expect(corto.status).toBe(422);
      const campos = corto.body.error.errores.map((x: { campo: string }) => x.campo);
      expect(campos).toEqual(expect.arrayContaining(['nombre', 'descripcion']));
      const inexistente = await crear({ permisos: ['inventado.todo'] });
      expect(inexistente.status).toBe(422);
      expect(inexistente.body.error.errores[0].campo).toBe('permisos');
      expect((await crear({ permisos: 'catalogos.administrar' })).status).toBe(422);
    });
  });

  describe('asignar el rol a un usuario', () => {
    async function usuarioConRol(rolId: number) {
      const r = await request(e.app)
        .post(`${api}/usuarios`)
        .set(auth(admin))
        .send({
          usuario: `rol${++contador}${Math.random().toString(36).slice(2, 6)}`,
          nombres: 'Persona de Prueba',
          correo: `p${contador}${Math.random().toString(36).slice(2, 6)}@barranquilla.gov.co`,
          rolId,
        });
      expect(r.status).toBe(201);
      // La contraseña temporal solo llega por correo.
      await e.servicios.correos.esperarDespachos();
      const temporal = /contraseña temporal es:\s+(\S+)/.exec(
        e.mailer.ultimo().text,
      )?.[1] as string;
      await e.pool.query(`UPDATE usuarios SET debe_cambiar_password = false WHERE id = $1`, [
        r.body.id,
      ]);
      const login = await request(e.app)
        .post('/api/v1/auth/login')
        .send({ usuario: r.body.usuario, password: temporal });
      expect(login.status).toBe(200);
      return { id: r.body.id as number, token: login.body.token as string };
    }

    it('quien tiene un rol propio recibe exactamente sus permisos y nada más', async () => {
      const rol = (await crear({ permisos: ['catalogos.administrar'] })).body as Rol;
      const u = await usuarioConRol(rol.id);
      expect((await request(e.app).get(`${api}/catalogos`).set(auth(u))).status).toBe(200);
      for (const ruta of ['/usuarios', '/roles', '/parametros', '/plantillas']) {
        expect((await request(e.app).get(`${api}${ruta}`).set(auth(u))).status, ruta).toBe(403);
      }
    });

    it('un usuario con un rol propio no entra a los parámetros aunque conozca la ruta', async () => {
      const rol = (await crear({ permisos: ['catalogos.administrar'] })).body as Rol;
      const u = await usuarioConRol(rol.id);
      expect((await request(e.app).get(`${api}/parametros`).set(auth(u))).status).toBe(403);
    });

    it('al cambiar los permisos del rol, el cambio rige de inmediato para quien lo tiene (mismo token)', async () => {
      const rol = (await crear({ permisos: ['catalogos.administrar'] })).body as Rol;
      const u = await usuarioConRol(rol.id);
      expect((await request(e.app).get(`${api}/plantillas`).set(auth(u))).status).toBe(403);
      const mod = await request(e.app)
        .put(`${api}/roles/${rol.id}`)
        .set(auth(admin))
        .send({
          nombre: rol.nombre,
          descripcion: rol.descripcion,
          permisos: ['catalogos.administrar', 'plantillas.administrar'],
        });
      expect(mod.status).toBe(200);
      expect(mod.body.usuarios).toBe(1);
      expect((await request(e.app).get(`${api}/plantillas`).set(auth(u))).status).toBe(200);
      await request(e.app)
        .put(`${api}/roles/${rol.id}`)
        .set(auth(admin))
        .send({ nombre: rol.nombre, descripcion: rol.descripcion, permisos: [] });
      expect((await request(e.app).get(`${api}/catalogos`).set(auth(u))).status).toBe(403);
    });

    it('al asignar otro rol, el anterior se reemplaza: queda uno solo', async () => {
      const a = (await crear({ permisos: ['catalogos.administrar'] })).body as Rol;
      const b = (await crear({ permisos: ['plantillas.administrar'] })).body as Rol;
      const u = await usuarioConRol(a.id);
      const usuario = (await get(`/usuarios/${u.id}`)).body;
      const mod = await request(e.app)
        .put(`${api}/usuarios/${u.id}`)
        .set(auth(admin))
        .send({ nombres: usuario.nombres, correo: usuario.correo, rolId: b.id });
      expect(mod.body.rol.id).toBe(b.id);
      const n = await e.pool.query(
        `SELECT count(*)::int AS n FROM usuario_rol WHERE usuario_id = $1`,
        [u.id],
      );
      expect(n.rows[0].n).toBe(1);
      expect((await request(e.app).get(`${api}/catalogos`).set(auth(u))).status).toBe(403);
      expect((await request(e.app).get(`${api}/plantillas`).set(auth(u))).status).toBe(200);
    });
  });

  describe('permisos exclusivos del administrador', () => {
    it('administrar los parámetros no se puede dar a ningún otro rol, ni al crear ni al modificar', async () => {
      const crearConParametros = await crear({
        nombre: 'Rol con parámetros',
        permisos: ['parametros.administrar'],
      });
      expect(crearConParametros.status).toBe(422);
      expect(crearConParametros.body.error.errores[0].mensaje).toContain(
        'solo lo tiene el administrador',
      );
      const rol = (await crear({ nombre: 'Rol sin parámetros' })).body as Rol;
      const r = await request(e.app)
        .put(`${api}/roles/${rol.id}`)
        .set(auth(admin))
        .send({
          nombre: 'Rol sin parámetros',
          descripcion: 'Intenta quedarse con los parámetros',
          permisos: ['catalogos.administrar', 'parametros.administrar'],
        });
      expect(r.status).toBe(422);
      const analista = await porCodigo('ANALISTA');
      const sistema = await request(e.app)
        .put(`${api}/roles/${analista.id}`)
        .set(auth(admin))
        .send({
          nombre: analista.nombre,
          descripcion: analista.descripcion,
          permisos: ['parametros.administrar'],
        });
      expect(sistema.status).toBe(422);
    });

    it('la lista de permisos marca los exclusivos del administrador (la pantalla los deshabilita)', async () => {
      const permisos = (await request(e.app).get(`${api}/permisos`).set(auth(admin))).body
        .items as { codigo: string; soloAdministrador: boolean }[];
      expect(permisos.find((p) => p.codigo === 'parametros.administrar')?.soloAdministrador).toBe(
        true,
      );
      expect(permisos.find((p) => p.codigo === 'catalogos.administrar')?.soloAdministrador).toBe(
        false,
      );
    });
  });

  describe('modificar un rol', () => {
    it('un rol propio se renombra y cambia de descripción y permisos, con valor anterior y nuevo en la bitácora', async () => {
      const rol = (await crear({ nombre: 'Rol por renombrar' })).body as Rol;
      const r = await request(e.app)
        .put(`${api}/roles/${rol.id}`)
        .set(auth(admin))
        .send({
          nombre: 'Rol ya renombrado',
          descripcion: 'Descripción nueva del rol',
          permisos: ['catalogos.administrar'],
        });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        nombre: 'Rol ya renombrado',
        descripcion: 'Descripción nueva del rol',
        permisos: ['catalogos.administrar'],
        codigo: rol.codigo,
      });
      const b = await e.pool.query(
        `SELECT valor_anterior, valor_nuevo FROM bitacora WHERE accion = 'ROL_MODIFICADO' AND entidad_id = $1`,
        [String(rol.id)],
      );
      expect(b.rows[0].valor_anterior.nombre).toBe('Rol por renombrar');
      expect(b.rows[0].valor_nuevo.nombre).toBe('Rol ya renombrado');
    });

    it('un rol del sistema no se renombra, pero se le pueden dar permisos cuando sus módulos existan', async () => {
      const analista = await porCodigo('ANALISTA');
      const renombrar = await request(e.app)
        .put(`${api}/roles/${analista.id}`)
        .set(auth(admin))
        .send({
          nombre: 'Otro nombre',
          descripcion: analista.descripcion,
          permisos: analista.permisos,
        });
      expect(renombrar.status).toBe(422);
      expect(renombrar.body.error.errores[0].campo).toBe('nombre');
      const ok = await request(e.app)
        .put(`${api}/roles/${analista.id}`)
        .set(auth(admin))
        .send({
          nombre: analista.nombre,
          descripcion: analista.descripcion,
          permisos: ['catalogos.administrar'],
        });
      expect(ok.status).toBe(200);
      expect(ok.body.permisos).toEqual(['catalogos.administrar']);
      await request(e.app)
        .put(`${api}/roles/${analista.id}`)
        .set(auth(admin))
        .send({ nombre: analista.nombre, descripcion: analista.descripcion, permisos: [] });
    });

    it('el rol de administrador no se puede modificar: nadie puede dejar el sistema sin administración', async () => {
      const a = await porCodigo('ADMINISTRADOR');
      const r = await request(e.app)
        .put(`${api}/roles/${a.id}`)
        .set(auth(admin))
        .send({ nombre: a.nombre, descripcion: a.descripcion, permisos: [] });
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('ROL_PROTEGIDO');
      expect((await porCodigo('ADMINISTRADOR')).permisos).toEqual(a.permisos);
    });

    it('un rol inexistente responde 404', async () => {
      const r = await request(e.app)
        .put(`${api}/roles/999999`)
        .set(auth(admin))
        .send({ nombre: 'Cualquiera', descripcion: 'Cualquier descripción', permisos: [] });
      expect(r.status).toBe(404);
    });
  });

  describe('eliminar un rol', () => {
    it('elimina un rol propio sin usuarios y lo registra en la bitácora', async () => {
      const rol = (await crear()).body as Rol;
      const r = await request(e.app).delete(`${api}/roles/${rol.id}`).set(auth(admin));
      expect(r.status).toBe(204);
      expect((await roles()).some((x) => x.id === rol.id)).toBe(false);
      const b = await e.pool.query(
        `SELECT valor_anterior FROM bitacora WHERE accion = 'ROL_ELIMINADO' AND entidad_id = $1`,
        [String(rol.id)],
      );
      expect(b.rows[0].valor_anterior.codigo).toBe(rol.codigo);
      const permisos = await e.pool.query(`SELECT 1 FROM rol_permiso WHERE rol_id = $1`, [rol.id]);
      expect(permisos.rows).toHaveLength(0);
    });

    it('no elimina un rol que tiene usuarios y explica cuántos', async () => {
      const rol = (await crear()).body as Rol;
      await request(e.app)
        .post(`${api}/usuarios`)
        .set(auth(admin))
        .send({
          usuario: `enuso${++contador}`,
          nombres: 'Persona En Uso',
          correo: `enuso${contador}@barranquilla.gov.co`,
          rolId: rol.id,
        })
        .expect(201);
      const r = await request(e.app).delete(`${api}/roles/${rol.id}`).set(auth(admin));
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('ROL_EN_USO');
      expect(r.body.error.mensaje).toContain('1 usuario');
      expect((await roles()).some((x) => x.id === rol.id)).toBe(true);
    });

    it('no elimina los roles del sistema ni uno que no existe', async () => {
      const analista = await porCodigo('ANALISTA');
      const r = await request(e.app).delete(`${api}/roles/${analista.id}`).set(auth(admin));
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('ROL_DEL_SISTEMA');
      expect((await request(e.app).delete(`${api}/roles/999999`).set(auth(admin))).status).toBe(
        404,
      );
    });
  });

  it('el administrador principal sigue obligado a conservar el rol de administrador', async () => {
    const principal = await crearCuenta(e, 'ADMINISTRADOR', { protegido: true });
    const rol = (await crear()).body as Rol;
    const r = await request(e.app)
      .put(`${api}/usuarios/${principal.id}`)
      .set(auth(admin))
      .send({
        nombres: 'Principal Admin',
        correo: `${principal.usuario}@alcaldia.test`,
        rolId: rol.id,
      });
    expect(r.body.error.codigo).toBe('USUARIO_PROTEGIDO');
  });
});
