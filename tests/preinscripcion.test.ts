import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearAplicacion } from '../src/presentation/http/app.js';
import { ErrorEnvioCorreo } from '../src/infrastructure/mail/mailer.js';
import { crearEntorno, type Entorno } from './helpers.js';

const pub = '/api/v1/publico';

interface Formulario {
  abierta: boolean;
  tiposIdentificacion: { id: number; codigo: string }[];
  localidades: { id: number; nombre: string }[];
  barrios: { id: number; nombre: string; localidadId: number }[];
  autorizacion: { version: number; contenido: string };
  formularioToken: string;
}

describe('preinscripción y verificación del correo (RF-PRE-01 a RF-PRE-04)', () => {
  let e: Entorno;
  let cc: number;
  let ce: number;
  let consecutivo = 1_000_000;

  beforeAll(async () => {
    e = await crearEntorno();
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body as Formulario;
    cc = f.tiposIdentificacion.find((t) => t.codigo === 'CC')!.id;
    ce = f.tiposIdentificacion.find((t) => t.codigo === 'CE')!.id;
  });
  afterAll(async () => {
    await e.cerrar();
  });
  beforeEach(async () => {
    await e.servicios.correos.esperarDespachos(); // envíos que dejó pendientes la prueba anterior
    e.mailer.enviados.length = 0;
    e.mailer.falla = null;
    e.reloj.ahora = new Date();
  });

  const formulario = async () =>
    (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body as Formulario;

  /** Abre el formulario y espera lo que tardaría una persona en llenarlo. */
  async function abrir() {
    const f = await formulario();
    e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 20_000);
    return f;
  }

  async function datos(extra: Record<string, unknown> = {}) {
    const f = await abrir();
    consecutivo += 2;
    return {
      pcdNombre: 'María Fernanda Pérez',
      pcdTipoIdentificacionId: cc,
      pcdNumero: String(consecutivo),
      cuidadorNombre: 'Carlos Andrés López',
      cuidadorTipoIdentificacionId: cc,
      cuidadorNumero: String(consecutivo + 1),
      direccion: 'Calle 45 # 20 - 10',
      localidadId: f.localidades[0]!.id,
      barrioId: f.barrios.find((b) => b.localidadId === f.localidades[0]!.id)!.id,
      correo: 'familia.perez@correo.com',
      aceptaAutorizacion: true,
      autorizacionVersion: f.autorizacion.version,
      formularioToken: f.formularioToken,
      ...extra,
      // Por defecto la confirmación es igual al correo que se haya indicado.
      correoConfirmacion: (extra.correoConfirmacion ??
        extra.correo ??
        'familia.perez@correo.com') as string,
    };
  }

  const enviar = (cuerpo: object) =>
    request(e.app).post(`${pub}/preinscripciones`).set('User-Agent', 'Prueba/1.0').send(cuerpo);
  const tokenDe = (texto: string) => /token=([A-Za-z0-9_-]+)/.exec(texto)![1]!;

  describe('formulario', () => {
    it('entrega los catálogos activos, el texto de autorización vigente y un token de formulario', async () => {
      const f = await formulario();
      expect(f.abierta).toBe(true);
      expect(f.tiposIdentificacion.map((t) => t.codigo)).toEqual(['CC', 'TI', 'RC', 'CE', 'PT']);
      expect(f.localidades).toHaveLength(5);
      expect(f.barrios).toHaveLength(178);
      expect(f.autorizacion.contenido).toContain('Ley 1581 de 2012');
      expect(f.formularioToken.split('.')).toHaveLength(3);
    });

    it('no ofrece los elementos desactivados', async () => {
      const f = await formulario();
      const barrio = f.barrios[0]!;
      await e.pool.query(`UPDATE catalogo_items SET activo = false WHERE id = $1`, [barrio.id]);
      const despues = await formulario();
      expect(despues.barrios.find((b) => b.id === barrio.id)).toBeUndefined();
      await e.pool.query(`UPDATE catalogo_items SET activo = true WHERE id = $1`, [barrio.id]);
    });
  });

  describe('registro', () => {
    it('registra la preinscripción: personas, solicitud, aceptación con IP y versión, token cifrado y correo', async () => {
      const d = await datos();
      const r = await enviar(d);
      expect(r.status).toBe(201);
      expect(r.body.correoEnmascarado).toMatch(/^f\*+@correo\.com$/);
      const s = await e.pool.query(`SELECT * FROM solicitudes ORDER BY id DESC LIMIT 1`);
      expect(s.rows[0].estado).toBe('PREINSCRITA');
      expect(s.rows[0].correo).toBe('familia.perez@correo.com');
      const a = await e.pool.query(
        `SELECT * FROM aceptaciones_autorizacion WHERE solicitud_id = $1`,
        [s.rows[0].id],
      );
      expect(a.rows[0].version).toBe(d.autorizacionVersion);
      expect(a.rows[0].ip).toBeTruthy();
      expect(a.rows[0].user_agent).toBe('Prueba/1.0');
      expect(a.rows[0].aceptada_at).toBeInstanceOf(Date);
      // El token nunca se guarda en claro: solo su hash.
      const enlace = tokenDe(e.mailer.ultimo().text);
      const t = await e.pool.query(
        `SELECT token_hash FROM solicitud_tokens WHERE solicitud_id = $1`,
        [s.rows[0].id],
      );
      expect(t.rows[0].token_hash).toHaveLength(64);
      expect(t.rows[0].token_hash).not.toContain(enlace);
      const b = await e.pool.query(`SELECT accion, ip FROM bitacora WHERE solicitud_id = $1`, [
        s.rows[0].id,
      ]);
      expect(b.rows[0].accion).toBe('SOLICITUD_PREINSCRITA');
    });

    it('envía el correo de verificación con el enlace, la vigencia y la aclaración de que no es aprobación', async () => {
      await enviar(await datos());
      await e.servicios.correos.esperarDespachos();
      const m = e.mailer.ultimo();
      expect(m.to).toBe('familia.perez@correo.com');
      expect(m.subject).toContain('Verifique su correo');
      expect(m.text).toContain('http://localhost:4300/verificar-correo?token=');
      expect(m.text).toContain('72 horas');
      expect(m.text).toContain('no equivale a la aprobación del beneficio');
      const c = await e.pool.query(
        `SELECT estado, message_id, tipo, cuerpo FROM correos ORDER BY id DESC LIMIT 1`,
      );
      expect(c.rows[0]).toMatchObject({ estado: 'ENVIADO', tipo: 'PREINSCRIPCION_VERIFICACION' });
      expect(c.rows[0].message_id).toBeTruthy();
      expect(c.rows[0].cuerpo).toBe(m.text);
    });

    it('un cuidador puede estar asociado a más de una persona con discapacidad (RN-01)', async () => {
      const comun = String(8_000_001);
      const a = await enviar(await datos({ cuidadorNumero: comun }));
      const b = await enviar(await datos({ cuidadorNumero: comun, cuidadorNombre: 'Otro nombre' }));
      expect([a.status, b.status]).toEqual([201, 201]);
      const n = await e.pool.query(
        `SELECT COUNT(*)::int n FROM solicitudes s JOIN personas p ON p.id = s.cuidador_id WHERE p.numero_identificacion = $1`,
        [comun],
      );
      expect(n.rows[0].n).toBe(2);
      const p = await e.pool.query(
        `SELECT nombre_completo FROM personas WHERE numero_identificacion = $1`,
        [comun],
      );
      expect(p.rowCount).toBe(1);
    });

    it('no permite preinscribir dos veces a la misma persona en la vigencia y ofrece consultar el estado', async () => {
      const d = await datos();
      expect((await enviar(d)).status).toBe(201);
      const f = await abrir();
      const otra = await enviar({
        ...d,
        formularioToken: f.formularioToken,
        correo: 'otro@correo.com',
        correoConfirmacion: 'otro@correo.com',
      });
      expect(otra.status).toBe(409);
      expect(otra.body.error.codigo).toBe('SOLICITUD_EXISTENTE');
      expect(otra.body.error.mensaje).toContain('consultar su estado');
      expect(JSON.stringify(otra.body)).not.toContain('María');
    });

    it('reconoce el mismo documento aunque se escriba con puntos, espacios o guiones', async () => {
      const d = await datos({ pcdNumero: '55.123.456' });
      expect((await enviar(d)).status).toBe(201);
      const f = await abrir();
      const igual = await enviar({
        ...d,
        pcdNumero: '55 123-456',
        formularioToken: f.formularioToken,
      });
      expect(igual.body.error.codigo).toBe('SOLICITUD_EXISTENTE');
    });

    it('dos envíos simultáneos de la misma persona crean una sola solicitud', async () => {
      const d = await datos();
      const [a, b] = await Promise.all([enviar(d), enviar(d)]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const n = await e.pool.query(
        `SELECT COUNT(*)::int n FROM solicitudes s JOIN personas p ON p.id = s.pcd_id WHERE p.numero_identificacion = $1`,
        [d.pcdNumero],
      );
      expect(n.rows[0].n).toBe(1);
    });
  });

  describe('validaciones', () => {
    const campos = (r: { body: { error: { errores: { campo: string }[] } } }) =>
      r.body.error.errores.map((x) => x.campo);

    it('exige los obligatorios y explica cuál falta o tiene un formato incorrecto', async () => {
      const f = await abrir();
      const r = await enviar({
        formularioToken: f.formularioToken,
        autorizacionVersion: f.autorizacion.version,
      });
      expect(r.status).toBe(422);
      expect(campos(r)).toEqual(
        expect.arrayContaining([
          'pcdNombre',
          'pcdTipoIdentificacionId',
          'pcdNumero',
          'cuidadorNombre',
          'cuidadorNumero',
          'correo',
          'aceptaAutorizacion',
        ]),
      );
      const mal = await enviar(await datos({ correo: 'sin-arroba', pcdNombre: '12345' }));
      expect(campos(mal)).toEqual(expect.arrayContaining(['correo', 'pcdNombre']));
      const correo = mal.body.error.errores.find((x: { campo: string }) => x.campo === 'correo');
      expect(correo.mensaje).toContain('Correo electrónico');
    });

    it('valida el formato del número según el tipo de documento', async () => {
      const cedula = await enviar(await datos({ pcdNumero: 'ABC123' }));
      expect(campos(cedula)).toContain('pcdNumero');
      expect(cedula.body.error.errores[0].mensaje).toContain('cédula de ciudadanía');
      const extranjeria = await enviar(
        await datos({ pcdTipoIdentificacionId: ce, pcdNumero: `X${consecutivo}A` }),
      );
      expect(extranjeria.status).toBe(201);
    });

    it('rechaza que la persona y su cuidador sean la misma', async () => {
      const d = await datos();
      const r = await enviar({ ...d, cuidadorNumero: d.pcdNumero });
      expect(r.status).toBe(422);
      expect(campos(r)).toContain('cuidadorNumero');
    });

    it('rechaza un tipo de identificación inexistente o desactivado', async () => {
      const r = await enviar(await datos({ pcdTipoIdentificacionId: 999999 }));
      expect(campos(r)).toContain('pcdTipoIdentificacionId');
    });

    it('el barrio debe pertenecer a la localidad elegida', async () => {
      const f = await abrir();
      const otraLocalidad = f.localidades[1]!.id;
      const barrioDeOtra = f.barrios.find((b) => b.localidadId === f.localidades[0]!.id)!.id;
      const r = await enviar(await datos({ localidadId: otraLocalidad, barrioId: barrioDeOtra }));
      expect(campos(r)).toContain('barrioId');
      const sinLocalidad = await enviar(await datos({ localidadId: null, barrioId: barrioDeOtra }));
      expect(campos(sinLocalidad)).toContain('localidadId');
    });

    it('el correo se escribe dos veces: si no coinciden, no se envía y el error es puntual', async () => {
      const r = await enviar(
        await datos({ correo: 'familia@correo.com', correoConfirmacion: 'famlia@correo.com' }),
      );
      expect(r.status).toBe(422);
      expect(campos(r)).toContain('correoConfirmacion');
      expect(JSON.stringify(r.body)).toContain('no coinciden');
      // Sin la confirmación tampoco se acepta.
      const sin = await datos();
      const { correoConfirmacion: _omitido, ...cuerpo } = sin;
      void _omitido;
      expect((await enviar(cuerpo)).status).toBe(422);
      // Mayúsculas y minúsculas no importan.
      expect(
        (
          await enviar(
            await datos({ correo: 'Mixto@Correo.com', correoConfirmacion: 'mixto@correo.COM' }),
          )
        ).status,
      ).toBe(201);
    });

    it('la dirección debe tener el formato estándar: acepta las bien armadas y rechaza el texto libre', async () => {
      for (const bien of [
        'Carrera 54 B Bis Sur # 72 A - 30 Este, Apto 301',
        'Avenida Carrera 46 # 80 - 17',
        'Vía 40 # 5 - 1',
      ]) {
        expect((await enviar(await datos({ direccion: bien }))).status, bien).toBe(201);
      }
      for (const mal of [
        'frente al parque',
        'Calle 45 # 20-10',
        'Camino 4 # 5 - 6',
        'Calle 0 # 5 - 6',
        'Calle 72 # 54 - 30, <script>',
        'Calle 1234 # 5 - 6',
        'calle 72 # 54 - 30',
      ]) {
        const r = await enviar(await datos({ direccion: mal }));
        expect(r.status, mal).toBe(422);
        expect(campos(r), mal).toContain('direccion');
      }
    });

    it('la dirección, la localidad y el barrio son opcionales', async () => {
      const r = await enviar(await datos({ direccion: null, localidadId: null, barrioId: null }));
      expect(r.status).toBe(201);
    });
  });

  describe('autorización de datos (RF-PRE-03)', () => {
    it('no se puede enviar sin aceptarla', async () => {
      const r = await enviar(await datos({ aceptaAutorizacion: false }));
      expect(r.status).toBe(422);
      expect(r.body.error.errores[0].campo).toBe('aceptaAutorizacion');
      expect(
        (
          await e.pool.query(
            `SELECT COUNT(*)::int n FROM aceptaciones_autorizacion WHERE solicitud_id NOT IN (SELECT id FROM solicitudes)`,
          )
        ).rows[0].n,
      ).toBe(0);
    });

    it('si el texto cambió mientras la persona llenaba el formulario, debe leerlo de nuevo', async () => {
      const d = await datos();
      await e.pool.query(`INSERT INTO textos_autorizacion (version, contenido) VALUES (2, $1)`, [
        'Texto nuevo de la autorización de datos personales. '.repeat(3),
      ]);
      const r = await enviar(d);
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('AUTORIZACION_CAMBIO');
      // Con la versión nueva sí se acepta, y queda registrada la versión que aceptó.
      const f = await abrir();
      const ok = await enviar({
        ...d,
        autorizacionVersion: f.autorizacion.version,
        formularioToken: f.formularioToken,
      });
      expect(ok.status).toBe(201);
      const a = await e.pool.query(
        `SELECT version FROM aceptaciones_autorizacion ORDER BY id DESC LIMIT 1`,
      );
      expect(a.rows[0].version).toBe(2);
      await e.pool
        .query(`DELETE FROM textos_autorizacion WHERE version = 2`)
        .catch(() => undefined);
    });

    it('las aceptaciones registradas no se pueden modificar ni borrar', async () => {
      await expect(e.pool.query(`UPDATE aceptaciones_autorizacion SET ip = 'x'`)).rejects.toThrow(
        /inmutable/,
      );
      await expect(e.pool.query(`DELETE FROM aceptaciones_autorizacion`)).rejects.toThrow(
        /inmutable/,
      );
    });
  });

  describe('protección contra envíos automatizados (RNF-04)', () => {
    it('rechaza el campo trampa lleno, el envío instantáneo, el token falso y el vencido', async () => {
      const trampa = await enviar(await datos({ contactoAlterno: 'https://spam.example' }));
      expect(trampa.status).toBe(400);
      expect(trampa.body.error.codigo).toBe('FORMULARIO_INVALIDO');

      const base = await datos();
      const f = await formulario(); // sin esperar: un robot responde al instante
      const rapido = await enviar({ ...base, formularioToken: f.formularioToken });
      expect(rapido.status).toBe(400);

      expect(
        (await enviar({ ...(await datos()), formularioToken: 'aaaaaaaa.bbbbbbbb.cccccccc' }))
          .status,
      ).toBe(400);

      const viejo = await formulario();
      e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 3 * 3600_000);
      const venc = await enviar({ ...(await datos()), formularioToken: viejo.formularioToken });
      expect(venc.status).toBe(400);
    });

    it('limita la cantidad de envíos por conexión', async () => {
      const { app } = crearAplicacion(e.deps, { limitarIntentos: true });
      let ultimo = 0;
      for (let i = 0; i < 11; i++) {
        ultimo = (await request(app).post(`${pub}/preinscripciones`).send({})).status;
      }
      expect(ultimo).toBe(429);
    });
  });

  describe('vigencia', () => {
    it('no recibe preinscripciones fuera de las fechas de la vigencia activa', async () => {
      const d = await datos();
      await e.pool.query(
        `UPDATE vigencias SET fecha_inicio = '2030-01-01', fecha_fin = '2030-12-31' WHERE activa`,
      );
      const r = await enviar(d);
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('PREINSCRIPCION_CERRADA');
      expect((await formulario()).abierta).toBe(false);
      await e.pool.query(
        `UPDATE vigencias SET fecha_inicio = '2026-01-01', fecha_fin = '2026-12-31' WHERE activa`,
      );
    });
  });

  describe('verificación del correo (RF-PRE-04)', () => {
    async function preinscribir() {
      e.mailer.enviados.length = 0;
      const d = await datos();
      await enviar(d);
      await e.servicios.correos.esperarDespachos();
      return { d, token: tokenDe(e.mailer.ultimo().text) };
    }
    const verificar = (token: string) =>
      request(e.app).post(`${pub}/preinscripciones/verificar-correo`).send({ token });

    it('verifica el correo, cambia el estado y envía la notificación con el siguiente paso y los enlaces', async () => {
      const { d, token } = await preinscribir();
      const r = await verificar(token);
      expect(r.status).toBe(200);
      expect(r.body.estado).toBe('VERIFICADO');
      await e.servicios.correos.esperarDespachos();
      const s = await e.pool.query(
        `SELECT estado, correo_verificado_at FROM solicitudes s JOIN personas p ON p.id = s.pcd_id WHERE p.numero_identificacion = $1`,
        [d.pcdNumero],
      );
      expect(s.rows[0].estado).toBe('CORREO_VERIFICADO');
      expect(s.rows[0].correo_verificado_at).toBeInstanceOf(Date);
      const m = e.mailer.ultimo();
      expect(m.subject).toContain('Preinscripción exitosa');
      expect(m.text).toContain('Correo verificado');
      expect(m.text).toContain('completar la caracterización');
      expect(m.text).toContain('/caracterizacion?token=');
      expect(m.text).toContain('/consulta?token=');
      expect(m.text).toContain('no equivale a la aprobación del beneficio');
      const b = await e.pool.query(
        `SELECT valor_anterior, valor_nuevo FROM bitacora WHERE accion = 'CORREO_VERIFICADO' ORDER BY id DESC LIMIT 1`,
      );
      expect(b.rows[0].valor_anterior.estado).toBe('PREINSCRITA');
      expect(b.rows[0].valor_nuevo.estado).toBe('CORREO_VERIFICADO');
    });

    it('usar el enlace otra vez no repite la notificación', async () => {
      const { token } = await preinscribir();
      await verificar(token);
      await e.servicios.correos.esperarDespachos();
      const antes = e.mailer.enviados.length;
      const otra = await verificar(token);
      expect(otra.body.estado).toBe('YA_VERIFICADO');
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(antes);
    });

    it('rechaza un enlace inventado y uno vencido', async () => {
      const malo = await verificar('x'.repeat(43));
      expect(malo.status).toBe(400);
      expect(malo.body.error.codigo).toBe('ENLACE_INVALIDO');
      const { token } = await preinscribir();
      e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 73 * 3600_000);
      const venc = await verificar(token);
      expect(venc.status).toBe(410);
      expect(venc.body.error.codigo).toBe('ENLACE_VENCIDO');
    });

    it('el plazo de vigencia del enlace sale del parámetro versionado', async () => {
      await e.pool.query(
        `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('verificacion_correo_horas', '1', 'prueba')`,
      );
      const { token } = await preinscribir();
      expect(e.mailer.ultimo().text).toContain('vigente por 1 horas');
      e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 2 * 3600_000);
      expect((await verificar(token)).status).toBe(410);
      await e.pool.query(
        `INSERT INTO parametro_versiones (clave, valor, justificacion) VALUES ('verificacion_correo_horas', '72', 'prueba')`,
      );
    });

    it('permite reenviar el enlace; el anterior deja de servir y se limita la frecuencia', async () => {
      const { d, token } = await preinscribir();
      const reenviar = () =>
        request(e.app)
          .post(`${pub}/preinscripciones/reenviar-verificacion`)
          .send({ tipoIdentificacionId: cc, numero: d.pcdNumero });
      e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 3 * 60_000);
      expect((await reenviar()).status).toBe(202);
      await e.servicios.correos.esperarDespachos();
      const nuevo = tokenDe(e.mailer.ultimo().text);
      expect(nuevo).not.toBe(token);
      // Un segundo reenvío inmediato no envía otro correo.
      const antes = e.mailer.enviados.length;
      expect((await reenviar()).status).toBe(202);
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(antes);
      expect((await verificar(token)).status).toBe(410);
      expect((await verificar(nuevo)).body.estado).toBe('VERIFICADO');
    });

    it('el reenvío responde igual si la identificación no existe y no envía nada', async () => {
      e.mailer.enviados.length = 0;
      const r = await request(e.app)
        .post(`${pub}/preinscripciones/reenviar-verificacion`)
        .send({ tipoIdentificacionId: cc, numero: '99999999' });
      expect(r.status).toBe(202);
      expect(r.body.mensaje).toContain('Si existe');
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(0);
    });

    it('no reenvía a quien ya verificó su correo', async () => {
      const { d, token } = await preinscribir();
      await verificar(token);
      await e.servicios.correos.esperarDespachos();
      e.mailer.enviados.length = 0;
      e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 10 * 60_000);
      await request(e.app)
        .post(`${pub}/preinscripciones/reenviar-verificacion`)
        .send({ tipoIdentificacionId: cc, numero: d.pcdNumero });
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(0);
    });
  });

  describe('estado de entrega de los correos (RNF-13)', () => {
    it('un fallo temporal deja el correo pendiente con su motivo y se reintenta solo', async () => {
      e.mailer.falla = new ErrorEnvioCorreo('Servidor de correo no disponible', false);
      await enviar(await datos());
      await e.servicios.correos.esperarDespachos();
      const c = (
        await e.pool.query(
          `SELECT id, estado, intentos, ultimo_error, proximo_intento_at FROM correos ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0];
      expect(c).toMatchObject({
        estado: 'PENDIENTE',
        intentos: 1,
        ultimo_error: 'Servidor de correo no disponible',
      });
      expect(c.proximo_intento_at.getTime()).toBeGreaterThan(Date.now());
      // Pasado el tiempo de espera y recuperado el servidor, sale.
      e.mailer.falla = null;
      await e.pool.query(`UPDATE correos SET proximo_intento_at = now() WHERE id = $1`, [c.id]);
      expect(await e.servicios.correos.procesarPendientes()).toBe(1);
      const despues = (
        await e.pool.query(`SELECT estado, intentos FROM correos WHERE id = $1`, [c.id])
      ).rows[0];
      expect(despues).toMatchObject({ estado: 'ENVIADO', intentos: 2 });
    });

    it('tras agotar los reintentos queda «fallido»', async () => {
      e.mailer.falla = new ErrorEnvioCorreo('caído', false);
      await enviar(await datos());
      await e.servicios.correos.esperarDespachos();
      const id = (await e.pool.query(`SELECT id FROM correos ORDER BY id DESC LIMIT 1`)).rows[0].id;
      for (let i = 0; i < 4; i++) {
        await e.pool.query(`UPDATE correos SET proximo_intento_at = now() WHERE id = $1`, [id]);
        await e.servicios.correos.procesarPendientes();
      }
      const c = (await e.pool.query(`SELECT estado, intentos FROM correos WHERE id = $1`, [id]))
        .rows[0];
      expect(c).toMatchObject({ estado: 'FALLIDO', intentos: 5 });
    });

    it('si el servidor rechaza la dirección, el correo queda «rebotado» y no se reintenta', async () => {
      e.mailer.falla = new ErrorEnvioCorreo('550 Buzón inexistente', true);
      await enviar(await datos({ correo: 'no-existe@correo.com' }));
      await e.servicios.correos.esperarDespachos();
      const c = (
        await e.pool.query(`SELECT estado, rebote_motivo FROM correos ORDER BY id DESC LIMIT 1`)
      ).rows[0];
      expect(c).toMatchObject({ estado: 'REBOTADO', rebote_motivo: '550 Buzón inexistente' });
    });

    it('el proveedor reporta entregas y rebotes por el webhook protegido con secreto', async () => {
      await enviar(await datos());
      await e.servicios.correos.esperarDespachos();
      const { id, message_id: messageId } = (
        await e.pool.query(`SELECT id, message_id FROM correos ORDER BY id DESC LIMIT 1`)
      ).rows[0];
      const hook = (cuerpo: object, secreto = 'secreto-de-prueba-del-webhook') =>
        request(e.app)
          .post('/api/v1/webhooks/correo')
          .set('x-webhook-secret', secreto)
          .send(cuerpo);
      expect((await hook({ messageId, evento: 'ENTREGADO' }, 'incorrecto')).status).toBe(403);
      expect(
        (
          await request(e.app)
            .post('/api/v1/webhooks/correo')
            .send({ messageId, evento: 'ENTREGADO' })
        ).status,
      ).toBe(403);
      expect((await hook({ messageId, evento: 'ENTREGADO' })).status).toBe(200);
      expect(
        (await e.pool.query(`SELECT estado, entregado_at FROM correos WHERE id = $1`, [id])).rows[0]
          .estado,
      ).toBe('ENTREGADO');
      expect((await hook({ messageId, evento: 'REBOTADO', detalle: 'Buzón lleno' })).status).toBe(
        200,
      );
      expect(
        (await e.pool.query(`SELECT estado, rebote_motivo FROM correos WHERE id = $1`, [id]))
          .rows[0],
      ).toMatchObject({ estado: 'REBOTADO', rebote_motivo: 'Buzón lleno' });
      expect((await hook({ messageId: '<desconocido@x>', evento: 'ENTREGADO' })).status).toBe(404);
      expect((await hook({ messageId, evento: 'OTRO' })).status).toBe(422);
    });

    it('el texto de un correo enviado no se puede modificar ni borrar', async () => {
      await expect(e.pool.query(`UPDATE correos SET cuerpo = 'otro'`)).rejects.toThrow(/inmutable/);
      await expect(e.pool.query(`DELETE FROM correos`)).rejects.toThrow(/no se pueden borrar/);
    });

    it('cada correo conserva el texto exacto con el que salió, el evento y la versión de la plantilla', async () => {
      await enviar(await datos());
      await e.servicios.correos.esperarDespachos();
      const c = (
        await e.pool.query(
          `SELECT tipo, plantilla_version, asunto, cuerpo FROM correos ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0];
      expect(c).toMatchObject({ tipo: 'PREINSCRIPCION_VERIFICACION', plantilla_version: 1 });
      expect(e.mailer.ultimo().subject).toBe(c.asunto);
      expect(e.mailer.ultimo().text).toBe(c.cuerpo);
    });
  });
});
