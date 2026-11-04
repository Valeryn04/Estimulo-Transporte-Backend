import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';

const api = '/api/v1/admin';

describe('configuración del programa (RF-ADM-02, RF-PRE-03)', () => {
  let e: Entorno;
  let admin: CuentaPrueba;

  beforeAll(async () => {
    e = await crearEntorno();
    admin = await crearCuenta(e, 'ADMINISTRADOR');
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const get = (ruta: string, c = admin) => request(e.app).get(`${api}${ruta}`).set(auth(c));
  const post = (ruta: string, cuerpo: object = {}, c = admin) =>
    request(e.app).post(`${api}${ruta}`).set(auth(c)).send(cuerpo);
  const put = (ruta: string, cuerpo: object, c = admin) =>
    request(e.app).put(`${api}${ruta}`).set(auth(c)).send(cuerpo);

  it('exige el permiso de cada grupo también en llamadas directas a la API', async () => {
    const analista = await crearCuenta(e, 'ANALISTA');
    for (const ruta of [
      '/catalogos',
      '/catalogos/EPS/items',
      '/documentos-requeridos',
      '/parametros',
      '/vigencias',
      '/autorizacion',
    ]) {
      expect((await get(ruta, analista)).status, ruta).toBe(403);
    }
    expect((await post('/autorizacion', { contenido: 'x'.repeat(60) }, analista)).status).toBe(403);
    expect((await request(e.app).get(`${api}/parametros`)).status).toBe(401);
  });

  describe('catálogos', () => {
    it('trae los catálogos iniciales del documento: tipos de identificación, transporte y causales', async () => {
      const resumen = (await get('/catalogos')).body.items as { catalogo: string; total: number }[];
      const total = (c: string) => resumen.find((x) => x.catalogo === c)?.total;
      expect(total('TIPO_IDENTIFICACION')).toBe(5);
      expect(total('TIPO_TRANSPORTE')).toBe(2);
      expect(total('CAUSAL_REVOCATORIA')).toBe(6);
      expect(total('LOCALIDAD')).toBe(5);
      expect(total('BARRIO')).toBe(178);
      const ids = await get('/catalogos/TIPO_IDENTIFICACION/items');
      expect(ids.body.items.map((x: { codigo: string }) => x.codigo)).toEqual([
        'CC',
        'TI',
        'RC',
        'CE',
        'PT',
      ]);
    });

    it('«Otro», «Ninguna» y «N/A» quedan siempre al final, aunque se agreguen opciones nuevas', async () => {
      const nombres = async (cat: string) =>
        ((await get(`/catalogos/${cat}/items?tamano=100`)).body.items as { nombre: string }[]).map(
          (x) => x.nombre,
        );
      await post('/catalogos/GENERO/items', { nombre: 'No binario' });
      expect(await nombres('GENERO')).toEqual([
        'Femenino',
        'Masculino',
        'No binario',
        'Otro',
        'N/A',
      ]);
      await post('/catalogos/ETNIA/items', { nombre: 'Rrom' });
      const etnias = await nombres('ETNIA');
      expect(etnias.slice(-3)).toEqual(['Rrom', 'Ninguna', 'N/A']);
    });

    it('«Ninguna» y «N/A» solo van en las listas que corresponden, con nombre y código fijos', async () => {
      const rechazo = async (cat: string, nombre: string) => {
        const r = await post(`/catalogos/${cat}/items`, { nombre });
        expect(r.status, `${cat} ${nombre}`).toBe(422);
        return r.body.error.errores[0].mensaje as string;
      };
      // Género y estado civil: solo «N/A». EPS, transporte, localidades y causales: ninguna de las dos.
      expect(await rechazo('GENERO', 'Ninguno')).toContain('no lleva la opción «Ninguna»');
      expect(await rechazo('ESTADO_CIVIL', 'ninguna')).toContain('no lleva la opción «Ninguna»');
      expect(await rechazo('EPS', 'Ninguna')).toContain('no lleva la opción «Ninguna»');
      expect(await rechazo('EPS', 'N/A')).toContain('no lleva la opción «N/A»');
      expect(await rechazo('TIPO_TRANSPORTE', 'No aplica')).toContain('no lleva la opción «N/A»');
      // Etnia, escolaridad y ocupación llevan solo «Ninguna/Ninguno» (nunca las dos): no se repite ni se agrega «N/A».
      expect(await rechazo('ETNIA', 'No aplica')).toContain('no lleva la opción «N/A»');
      expect(await rechazo('OCUPACION', 'Ninguno')).toContain('ya existe');
      // La EPS no tiene esas opciones activas.
      const eps = (await get('/catalogos/EPS/items?activo=true&tamano=100')).body.items as {
        codigo: string;
      }[];
      expect(eps.some((x) => x.codigo === 'NINGUNA' || x.codigo === 'NA')).toBe(false);
      // Una opción de cierre no se renombra, y otra opción no puede tomar ese nombre.
      const etnias = (await get('/catalogos/ETNIA/items?tamano=100')).body.items as {
        id: number;
        codigo: string;
        nombre: string;
      }[];
      const ninguna = etnias.find((x) => x.codigo === 'NINGUNA')!;
      const renombre = await put(`/catalogos/items/${ninguna.id}`, { nombre: 'Sin etnia' });
      expect(renombre.status).toBe(422);
      const otra = etnias.find((x) => x.codigo === 'RAIZAL')!;
      expect((await put(`/catalogos/items/${otra.id}`, { nombre: 'N/A' })).status).toBe(422);
    });

    it('crea un elemento con código automático, lo modifica y guarda cada versión con su autor', async () => {
      const c = await post('/catalogos/EPS/items', { nombre: 'Salud Ejemplo' });
      expect(c.status).toBe(201);
      expect(c.body.codigo).toBe('SALUD_EJEMPLO');
      expect(c.body.version).toBe(1);
      const m = await put(`/catalogos/items/${c.body.id}`, {
        nombre: 'Salud Ejemplo S.A.',
      });
      expect(m.body.version).toBe(2);
      const v = await get(`/catalogos/items/${c.body.id}/versiones`);
      expect(v.body.items.map((x: { version: number }) => x.version)).toEqual([2, 1]);
      expect(v.body.items[1].snapshot.nombre).toBe('Salud Ejemplo');
      expect(v.body.items[0].usuario).toBe(admin.usuario);
      const b = await e.pool.query(
        `SELECT accion, valor_anterior, valor_nuevo FROM bitacora WHERE entidad_id = $1 AND modulo = 'catalogos' ORDER BY id`,
        [String(c.body.id)],
      );
      expect(b.rows.map((x) => x.accion)).toEqual(['CATALOGO_CREADO', 'CATALOGO_MODIFICADO']);
      expect(b.rows[1].valor_anterior.nombre).toBe('Salud Ejemplo');
    });

    it('no permite nombres ni códigos repetidos en la misma lista', async () => {
      const r = await post('/catalogos/EPS/items', { nombre: 'sanitas' });
      expect(r.status).toBe(422);
      expect(r.body.error.errores[0].campo).toBe('nombre');
      const cod = await post('/catalogos/TIPO_IDENTIFICACION/items', {
        nombre: 'Otro documento',
        codigo: 'cc',
      });
      expect(cod.body.error.errores[0].campo).toBe('codigo');
    });

    it('un tipo de identificación exige su sigla', async () => {
      const r = await post('/catalogos/TIPO_IDENTIFICACION/items', { nombre: 'Pasaporte' });
      expect(r.status).toBe(422);
      expect(r.body.error.errores[0].campo).toBe('codigo');
      expect(
        (await post('/catalogos/TIPO_IDENTIFICACION/items', { nombre: 'Pasaporte', codigo: 'PA' }))
          .status,
      ).toBe(201);
    });

    it('un barrio exige una localidad activa; una localidad no puede tener barrios', async () => {
      const localidades = (await get('/catalogos/LOCALIDAD/items')).body.items as { id: number }[];
      const sin = await post('/catalogos/BARRIO/items', { nombre: 'Barrio Nuevo' });
      expect(sin.body.error.errores[0].campo).toBe('padreId');
      const mala = await post('/catalogos/BARRIO/items', {
        nombre: 'Barrio Nuevo',
        padreId: 99999,
      });
      expect(mala.status).toBe(422);
      const ok = await post('/catalogos/BARRIO/items', {
        nombre: 'Barrio Nuevo',
        padreId: localidades[0]!.id,
      });
      expect(ok.status).toBe(201);
      expect(ok.body.codigo).toBe('B_BARRIO_NUEVO');
      expect(ok.body.padreNombre).toBeTruthy();
      const aLoc = await post('/catalogos/LOCALIDAD/items', {
        nombre: 'Localidad Nueva',
        padreId: localidades[0]!.id,
      });
      expect(aLoc.status).toBe(201);
      expect(aLoc.body.padreId).toBeNull();
    });

    it('filtra por localidad y busca por nombre', async () => {
      const loc = (await get('/catalogos/LOCALIDAD/items?q=riomar')).body.items[0] as {
        id: number;
      };
      const r = await get(`/catalogos/BARRIO/items?padreId=${loc.id}&tamano=100`);
      expect(r.body.total).toBeGreaterThan(10);
      expect(r.body.items.every((b: { padreId: number }) => b.padreId === loc.id)).toBe(true);
      const q = await get('/catalogos/BARRIO/items?q=Altamira');
      expect(q.body.items.map((b: { nombre: string }) => b.nombre)).toContain('Altamira');
      expect((await get('/catalogos/BARRIO/items?q=%25')).body.total).toBe(0);
    });

    it('desactivar no borra: la localidad con barrios activos no se puede desactivar', async () => {
      const loc = (await get('/catalogos/LOCALIDAD/items?q=riomar')).body.items[0] as {
        id: number;
      };
      const r = await post(`/catalogos/items/${loc.id}/desactivar`);
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('TIENE_BARRIOS_ACTIVOS');
      const eps = (await get('/catalogos/EPS/items?q=Famisanar')).body.items[0] as { id: number };
      const d = await post(`/catalogos/items/${eps.id}/desactivar`);
      expect(d.body.activo).toBe(false);
      expect((await post(`/catalogos/items/${eps.id}/desactivar`)).status).toBe(409);
      expect((await post(`/catalogos/items/${eps.id}/activar`)).body.activo).toBe(true);
      const inactivos = await get('/catalogos/EPS/items?activo=false');
      // Solo queda inactiva la «Ninguna» que se retiró de la EPS (migración 013).
      expect(inactivos.body.items.map((x: { codigo: string }) => x.codigo)).toEqual(['NINGUNA']);
    });

    it('rechaza una lista inexistente', async () => {
      expect((await get('/catalogos/INVENTADA/items')).status).toBe(400);
    });
  });

  describe('documentos exigidos (RN-06)', () => {
    it('trae los documentos mínimos de la PCD, el cuidador y el común', async () => {
      const docs = (await get('/documentos-requeridos')).body.items as {
        aplicaA: string;
        codigo: string;
      }[];
      expect(docs.filter((d) => d.aplicaA === 'PCD')).toHaveLength(4);
      expect(docs.filter((d) => d.aplicaA === 'CUIDADOR')).toHaveLength(3);
      expect(docs.filter((d) => d.aplicaA === 'COMUN')).toHaveLength(1);
    });

    it('permite crear, modificar y desactivar un documento, versionado y en bitácora', async () => {
      const c = await post('/documentos-requeridos', {
        nombre: 'Registro RLCPD',
        descripcion: 'Soporte del registro de localización',
        aplicaA: 'PCD',
        obligatorio: true,
      });
      expect(c.status).toBe(201);
      expect(c.body.codigo).toBe('PCD_REGISTRO_RLCPD');
      const m = await put(`/documentos-requeridos/${c.body.id}`, {
        nombre: 'Registro RLCPD',
        descripcion: 'Soporte actualizado',
        aplicaA: 'PCD',
        obligatorio: false,
      });
      expect(m.body.version).toBe(2);
      expect(m.body.obligatorio).toBe(false);
      expect((await post(`/documentos-requeridos/${c.body.id}/desactivar`)).body.activo).toBe(
        false,
      );
      const v = await get(`/documentos-requeridos/${c.body.id}/versiones`);
      expect(v.body.items).toHaveLength(3);
      const b = await e.pool.query(
        `SELECT COUNT(*)::int n FROM bitacora WHERE entidad = 'documento_requerido' AND entidad_id = $1`,
        [String(c.body.id)],
      );
      expect(b.rows[0].n).toBe(3);
    });

    it('valida los datos', async () => {
      const r = await post('/documentos-requeridos', {
        nombre: 'x',
        aplicaA: 'OTRO',
        obligatorio: 'si',
      });
      expect(r.status).toBe(422);
      const repetido = await post('/documentos-requeridos', {
        nombre: 'Certificado de discapacidad',
        aplicaA: 'PCD',
        obligatorio: true,
      });
      expect(repetido.status).toBe(422);
    });
  });

  describe('parámetros versionados (RNF-12)', () => {
    it('lista solo los parámetros que el software ya usa, con su valor vigente y su rango permitido', async () => {
      const lista = (await get('/parametros')).body.items as {
        clave: string;
        minimo: number | null;
        maximo: number | null;
        vigente: { valor: string };
      }[];
      const por = (k: string) => lista.find((p) => p.clave === k);
      expect(lista.map((p) => p.clave).sort()).toEqual([
        'archivo_formatos',
        'archivo_max_mb',
        'enlace_seguro_dias',
        'entrega_activacion_inmediata',
        'entrega_documentos',
        'entrega_instrucciones',
        'entrega_lugar',
        'entrega_recomendaciones',
        'inactividad_meses',
        'login_bloqueo_minutos',
        'login_max_intentos',
        'max_rondas_subsanacion',
        'meta_beneficiarios',
        'otp_vigencia_minutos',
        'plazo_decision_dias',
        'plazo_descargos_dias',
        'plazo_recursos_dias',
        'plazo_subsanacion_dias',
        'reenvio_verificacion_minutos',
        'sesion_inactividad_minutos',
        'sesion_maxima_horas',
        'subsanacion_recordatorio_dias',
        'tarjeta_digitos',
        'tarjeta_prefijo',
        'tiempo_max_atencion_dias',
        'verificacion_correo_horas',
      ]);
      expect(por('archivo_max_mb')?.vigente.valor).toBe('5');
      expect(por('archivo_formatos')?.vigente.valor).toBe('pdf,jpg,png');
      // El tamaño por documento nunca pasa de 10 MB y los de seguridad tienen rangos cortos.
      expect(por('archivo_max_mb')).toMatchObject({ minimo: 1, maximo: 10 });
      expect(por('otp_vigencia_minutos')).toMatchObject({ minimo: 5, maximo: 15 });
      expect(por('sesion_maxima_horas')).toMatchObject({ minimo: 1, maximo: 12 });
      // La meta del programa alimenta el avance del tablero.
      expect(por('meta_beneficiarios')?.vigente.valor).toBe('3000');
    });

    it('el tamaño máximo por documento no puede pasar de 10 MB', async () => {
      const campo = async (valor: string) => {
        const r = await post('/parametros/archivo_max_mb/versiones', {
          valor,
          justificacion: 'prueba de límite',
        });
        return { status: r.status, mensaje: r.body.error?.errores?.[0]?.mensaje as string };
      };
      expect((await campo('25')).status).toBe(422);
      expect((await campo('25')).mensaje).toContain('máximo permitido es 10');
      expect((await campo('11')).status).toBe(422);
      expect((await campo('10')).status).toBe(201);
      // El servidor tampoco usa más de 10 MB aunque la base de datos tuviera un valor mayor.
      await e.pool.query(`UPDATE parametros SET maximo = 100 WHERE clave = 'archivo_max_mb'`);
      expect((await campo('50')).status).toBe(201);
      const reglas = await e.servicios.documentos.reglas();
      expect(reglas.maxMb).toBe(10);
      expect(reglas.maxBytes).toBe(10 * 1_048_576);
      await e.pool.query(`UPDATE parametros SET maximo = 10 WHERE clave = 'archivo_max_mb'`);
      await post('/parametros/archivo_max_mb/versiones', { valor: '5', justificacion: 'volver' });
    });

    it('un cambio crea una versión con aprobador y motivo, rige de inmediato y conserva el historial', async () => {
      const r = await post('/parametros/verificacion_correo_horas/versiones', {
        valor: '96',
        justificacion: 'Manual operativo v2',
      });
      expect(r.status).toBe(201);
      expect(r.body.vigente.valor).toBe('96');
      expect(r.body.vigente.aprobadoPor).toBe(admin.usuario);
      expect(r.body.pendienteDefinicion).toBe(false);
      const h = await get('/parametros/verificacion_correo_horas/historial');
      expect(h.body.items.map((x: { valor: string }) => x.valor)).toEqual(['96', '72']);
      const b = await e.pool.query(
        `SELECT valor_anterior, valor_nuevo, justificacion FROM bitacora
          WHERE accion = 'PARAMETRO_VERSION_CREADA' AND entidad_id = 'verificacion_correo_horas'`,
      );
      expect(b.rows[0].valor_anterior.valor).toBe('72');
      expect(b.rows[0].justificacion).toBe('Manual operativo v2');
    });

    it('un cambio de seguridad se aplica sin desplegar nada (intentos de ingreso)', async () => {
      await post('/parametros/login_max_intentos/versiones', {
        valor: '3',
        justificacion: 'Endurecer el acceso',
      });
      const u = await e.pool.query(
        `INSERT INTO usuarios (usuario, nombres, correo, password_hash) VALUES ('probando', 'Probando Uno', 'p@x.co', 'x') RETURNING id`,
      );
      await e.pool.query(
        `INSERT INTO usuario_rol (usuario_id, rol_id) SELECT $1, id FROM roles WHERE codigo = 'ANALISTA'`,
        [u.rows[0].id],
      );
      for (let i = 0; i < 3; i++)
        await request(e.app)
          .post('/api/v1/auth/login')
          .send({ usuario: 'probando', password: 'mala' });
      const r = await request(e.app)
        .post('/api/v1/auth/login')
        .send({ usuario: 'probando', password: 'mala' });
      expect(r.body.error.codigo).toBe('CUENTA_BLOQUEADA');
    });

    it('programa un valor para una fecha futura: no rige hasta entonces', async () => {
      const futuro = new Date(Date.now() + 7 * 86_400_000).toISOString();
      const r = await post('/parametros/enlace_seguro_dias/versiones', {
        valor: '120',
        vigenteDesde: futuro,
        justificacion: 'Nueva convocatoria',
      });
      expect(r.body.vigente.valor).toBe('90');
      expect(r.body.programada.valor).toBe('120');
    });

    it('valida tipo, rango y formato', async () => {
      const campo = async (clave: string, valor: string) => {
        const r = await post(`/parametros/${clave}/versiones`, {
          valor,
          justificacion: 'prueba de validación',
        });
        expect(r.status, `${clave}=${valor}`).toBe(422);
        return r.body.error.errores[0].mensaje as string;
      };
      expect(await campo('archivo_max_mb', 'cinco')).toContain('entero');
      expect(await campo('archivo_max_mb', '500')).toContain('máximo');
      expect(await campo('archivo_max_mb', '0')).toContain('mínimo');
      expect(await campo('archivo_formatos', 'exe,pdf')).toContain('formato');
      expect(
        (
          await post('/parametros/archivo_formatos/versiones', {
            valor: 'pdf,png',
            justificacion: 'solo pdf y png',
          })
        ).status,
      ).toBe(201);
    });

    it('exige motivo, rechaza fechas pasadas y valores iguales al vigente', async () => {
      expect((await post('/parametros/archivo_max_mb/versiones', { valor: '6' })).status).toBe(422);
      const pasado = await post('/parametros/archivo_max_mb/versiones', {
        valor: '6',
        vigenteDesde: '2020-01-01T00:00:00Z',
        justificacion: 'retroactivo',
      });
      expect(pasado.status).toBe(422);
      const igual = await post('/parametros/archivo_max_mb/versiones', {
        valor: '5',
        justificacion: 'sin cambios',
      });
      expect(igual.status).toBe(409);
      expect(
        (await post('/parametros/no_existe/versiones', { valor: '1', justificacion: 'no existe' }))
          .status,
      ).toBe(404);
    });
  });

  describe('vigencias y cupos (RF-ADM-02, RF-ASG-03)', () => {
    it('hay una vigencia activa y se registran los cupos totales', async () => {
      const v = (await get('/vigencias')).body.items as {
        id: number;
        anio: number;
        activa: boolean;
      }[];
      expect(v).toHaveLength(1);
      expect(v[0]).toMatchObject({ anio: 2026, activa: true });
      // Los cupos no se cambian por aquí: se modifican con su soporte en «Cupos y presupuesto».
      const conCupos = await put(`/vigencias/${v[0]!.id}`, {
        fechaInicio: '2026-01-01',
        fechaFin: '2026-12-31',
        cuposTotales: 3000,
      });
      expect(conCupos.status).toBe(422);
      expect(conCupos.body.error.errores[0].campo).toBe('cuposTotales');
      const m = await put(`/vigencias/${v[0]!.id}`, {
        fechaInicio: '2026-01-01',
        fechaFin: '2026-12-31',
        cuposTotales: 0,
      });
      expect(m.body.cuposTotales).toBe(0);
      expect(m.body.version).toBe(2);
      expect((await get(`/vigencias/${v[0]!.id}/versiones`)).body.items).toHaveLength(2);
    });

    it('valida cupos, fechas, año repetido y cruces entre vigencias', async () => {
      const base = {
        anio: 2027,
        fechaInicio: '2027-01-01',
        fechaFin: '2027-12-31',
        cuposTotales: 100,
      };
      expect((await post('/vigencias', { ...base, cuposTotales: -1 })).status).toBe(422);
      expect((await post('/vigencias', { ...base, fechaFin: '2026-12-31' })).status).toBe(422);
      expect((await post('/vigencias', { ...base, anio: 2026 })).body.error.errores[0].campo).toBe(
        'anio',
      );
      const cruce = await post('/vigencias', { ...base, fechaInicio: '2026-12-01' });
      expect(cruce.body.error.errores[0].mensaje).toContain('2026');
      expect((await post('/vigencias', base)).status).toBe(201);
    });

    it('solo una vigencia está activa a la vez', async () => {
      const lista = (await get('/vigencias')).body.items as { id: number; anio: number }[];
      const v2027 = lista.find((v) => v.anio === 2027)!;
      expect((await post(`/vigencias/${v2027.id}/activar`)).body.activa).toBe(true);
      const despues = (await get('/vigencias')).body.items as { anio: number; activa: boolean }[];
      expect(despues.filter((v) => v.activa).map((v) => v.anio)).toEqual([2027]);
      expect((await post(`/vigencias/${v2027.id}/activar`)).status).toBe(409);
    });
  });

  describe('texto de autorización de datos (RF-PRE-03)', () => {
    it('trae la versión inicial y cada cambio genera una versión nueva sin alterar las anteriores', async () => {
      const antes = await get('/autorizacion');
      expect(antes.body.vigente.version).toBe(1);
      expect(antes.body.vigente.contenido).toContain('Ley 1581 de 2012');
      const nueva = await post('/autorizacion', {
        contenido: `${antes.body.vigente.contenido}\n\nCláusula adicional de prueba.`,
      });
      expect(nueva.status).toBe(201);
      expect(nueva.body.version).toBe(2);
      const despues = await get('/autorizacion');
      expect(despues.body.vigente.version).toBe(2);
      expect(despues.body.versiones).toHaveLength(2);
      expect(despues.body.versiones[1].contenido).toBe(antes.body.vigente.contenido);
      expect(despues.body.versiones[0].creadoPor).toBe(admin.usuario);
    });

    it('rechaza un texto corto o idéntico al vigente, y la tabla es inmutable', async () => {
      expect((await post('/autorizacion', { contenido: 'corto' })).status).toBe(422);
      const vigente = (await get('/autorizacion')).body.vigente.contenido as string;
      expect((await post('/autorizacion', { contenido: vigente })).status).toBe(409);
      await expect(e.pool.query(`UPDATE textos_autorizacion SET contenido = 'x'`)).rejects.toThrow(
        /inmutable/,
      );
      await expect(e.pool.query(`DELETE FROM textos_autorizacion`)).rejects.toThrow(/inmutable/);
    });
  });
});
