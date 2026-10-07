import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crearAplicacion } from '../src/presentation/http/app.js';
import { crearEntorno, type Entorno } from './helpers.js';

const pub = '/api/v1/publico';

interface Formulario {
  tiposIdentificacion: { id: number; codigo: string }[];
  autorizacion: { version: number };
  formularioToken: string;
}

describe('consulta del estado de la solicitud (RF-PRE-05)', () => {
  let e: Entorno;
  let cc: number;
  let consecutivo = 3_000_000;

  beforeAll(async () => {
    e = await crearEntorno();
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body as Formulario;
    cc = f.tiposIdentificacion.find((t) => t.codigo === 'CC')!.id;
  });
  afterAll(async () => {
    await e.cerrar();
  });
  beforeEach(async () => {
    await e.servicios.correos.esperarDespachos();
    e.mailer.enviados.length = 0;
    e.reloj.ahora = new Date();
  });

  const tokenDe = (texto: string) => /token=([A-Za-z0-9_-]+)/.exec(texto)![1]!;
  const codigoDe = (texto: string) => /\n\n(\d{6})\n\n/.exec(texto)![1]!;
  const adelantar = (minutos: number) => {
    e.reloj.ahora = new Date(e.reloj.ahora.getTime() + minutos * 60_000);
  };

  /** Preinscribe a una persona y, si se pide, verifica su correo. Devuelve su identificación y los enlaces. */
  async function solicitud(opciones: { verificar?: boolean; correo?: string } = {}) {
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body as Formulario;
    adelantar(1);
    consecutivo += 2;
    const numero = String(consecutivo);
    const r = await request(e.app)
      .post(`${pub}/preinscripciones`)
      .send({
        pcdNombre: 'María Fernanda Pérez',
        pcdTipoIdentificacionId: cc,
        pcdNumero: numero,
        cuidadorNombre: 'Carlos López',
        cuidadorTipoIdentificacionId: cc,
        cuidadorNumero: String(consecutivo + 1),
        correo: opciones.correo ?? 'familia@correo.com',
        aceptaAutorizacion: true,
        autorizacionVersion: f.autorizacion.version,
        formularioToken: f.formularioToken,
      });
    expect(r.status).toBe(201);
    await e.servicios.correos.esperarDespachos();
    let enlaceSeguro: string | null = null;
    if (opciones.verificar !== false) {
      const verificacion = tokenDe(e.mailer.ultimo().text);
      await request(e.app)
        .post(`${pub}/preinscripciones/verificar-correo`)
        .send({ token: verificacion });
      await e.servicios.correos.esperarDespachos();
      enlaceSeguro = tokenDe(e.mailer.ultimo().text);
    }
    e.mailer.enviados.length = 0;
    return { numero, enlaceSeguro };
  }

  const pedirCodigo = (numero: string) =>
    request(e.app)
      .post(`${pub}/consulta/solicitar-codigo`)
      .send({ tipoIdentificacionId: cc, numero });
  const verificar = (numero: string, codigo: string) =>
    request(e.app)
      .post(`${pub}/consulta/verificar-codigo`)
      .send({ tipoIdentificacionId: cc, numero, codigo });
  const consultar = (token: string) =>
    request(e.app).get(`${pub}/consulta/solicitud`).set('Authorization', `Bearer ${token}`);

  describe('código de un solo uso enviado al correo registrado', () => {
    it('envía un código de 6 dígitos al correo verificado y responde igual exista o no la solicitud', async () => {
      const { numero } = await solicitud();
      const r = await pedirCodigo(numero);
      expect(r.status).toBe(202);
      await e.servicios.correos.esperarDespachos();
      const m = e.mailer.ultimo();
      expect(m.to).toBe('familia@correo.com');
      expect(m.subject).toContain('código de consulta');
      expect(codigoDe(m.text)).toMatch(/^\d{6}$/);
      expect(m.text).toContain('solo se puede usar una vez');

      e.mailer.enviados.length = 0;
      const inexistente = await pedirCodigo('99999999');
      expect(inexistente.status).toBe(202);
      expect(inexistente.body).toEqual(r.body);
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(0);
    });

    it('no envía código si el correo no está verificado', async () => {
      const { numero } = await solicitud({ verificar: false });
      expect((await pedirCodigo(numero)).status).toBe(202);
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(0);
    });

    it('guarda solo el hash del código, nunca el código en claro', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const codigo = codigoDe(e.mailer.ultimo().text);
      const { rows } = await e.pool.query(
        `SELECT codigo_hash FROM codigos_consulta ORDER BY id DESC LIMIT 1`,
      );
      expect(rows[0].codigo_hash).toHaveLength(64);
      expect(rows[0].codigo_hash).not.toContain(codigo);
    });

    it('limita la frecuencia: un segundo código inmediato no se envía y tras 1 minuto sí', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(1);
      adelantar(2);
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(2);
    });

    it('permite máximo 5 códigos por hora y por solicitud', async () => {
      const { numero } = await solicitud();
      for (let i = 0; i < 7; i++) {
        await pedirCodigo(numero);
        adelantar(2);
      }
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(5);
    });

    it('con el código correcto se abre la sesión y se ve el estado, la explicación y el siguiente paso', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const v = await verificar(numero, codigoDe(e.mailer.ultimo().text));
      expect(v.status).toBe(200);
      expect(v.body.expiraEnMinutos).toBe(30);
      const r = await consultar(v.body.token);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        vigencia: 2026,
        personaConDiscapacidad: 'María Fernanda Pérez',
        etapa: 'Preinscripción',
        estado: { codigo: 'CORREO_VERIFICADO', nombre: 'Correo verificado' },
      });
      expect(r.body.explicacion).toContain('correo está verificado');
      expect(r.body.siguientePaso).toContain('caracterización');
      expect(r.body.aviso).toContain('no equivale a la aprobación del beneficio');
      expect(r.body.correo).toMatch(/^f\*+@correo\.com$/);
    });

    it('lista las comunicaciones enviadas con su estado de entrega, sin mostrar el código de consulta', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const codigo = codigoDe(e.mailer.ultimo().text);
      const v = await verificar(numero, codigo);
      const r = await consultar(v.body.token);
      const nombres = r.body.comunicaciones.map((c: { nombre: string }) => c.nombre);
      expect(nombres).toEqual(['Preinscripción exitosa', 'Verificación del correo']);
      expect(r.body.comunicaciones[0]).toMatchObject({ entrega: 'Enviado' });
      expect(r.body.comunicaciones[0].asunto).toContain('Preinscripción exitosa');
      expect(JSON.stringify(r.body)).not.toContain(codigo);
      expect(JSON.stringify(r.body)).not.toContain('familia@correo.com');
    });

    it('el código sirve una sola vez', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const codigo = codigoDe(e.mailer.ultimo().text);
      expect((await verificar(numero, codigo)).status).toBe(200);
      const otra = await verificar(numero, codigo);
      expect(otra.status).toBe(401);
      expect(otra.body.error.codigo).toBe('CODIGO_INVALIDO');
    });

    it('un código vencido no sirve (vigencia del parámetro otp_vigencia_minutos)', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const codigo = codigoDe(e.mailer.ultimo().text);
      adelantar(11);
      expect((await verificar(numero, codigo)).status).toBe(401);
    });

    it('un código nuevo anula el anterior', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const viejo = codigoDe(e.mailer.ultimo().text);
      adelantar(2);
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const nuevo = codigoDe(e.mailer.ultimo().text);
      if (viejo !== nuevo) expect((await verificar(numero, viejo)).status).toBe(401);
      expect((await verificar(numero, nuevo)).status).toBe(200);
    });

    it('un código incorrecto da el mismo error que una identificación inexistente y se anula tras 5 intentos', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      const bueno = codigoDe(e.mailer.ultimo().text);
      const malo = bueno === '000000' ? '111111' : '000000';
      const fallo = await verificar(numero, malo);
      const sinSolicitud = await verificar('99999999', malo);
      expect(fallo.status).toBe(401);
      expect(fallo.body.error).toEqual(sinSolicitud.body.error);
      for (let i = 0; i < 4; i++) await verificar(numero, malo);
      // Agotados los intentos, ni el código correcto sirve.
      expect((await verificar(numero, bueno)).status).toBe(401);
      const b = await e.pool.query(
        `SELECT COUNT(*)::int n FROM bitacora b
           JOIN solicitudes s ON s.id = b.solicitud_id JOIN personas p ON p.id = s.pcd_id
          WHERE b.accion = 'CONSULTA_CODIGO_FALLIDO' AND p.numero_identificacion = $1`,
        [numero],
      );
      expect(b.rows[0].n).toBe(5);
      // Pidiendo un código nuevo se puede volver a intentar.
      adelantar(2);
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      expect((await verificar(numero, codigoDe(e.mailer.ultimo().text))).status).toBe(200);
    });

    it('valida el formato del código y de la identificación', async () => {
      const r = await verificar('1234567', 'abc');
      expect(r.status).toBe(422);
      expect(r.body.error.errores[0].campo).toBe('codigo');
      expect((await pedirCodigo('')).status).toBe(422);
    });

    it('registra en la bitácora la solicitud del código y el acceso', async () => {
      const { numero } = await solicitud();
      await pedirCodigo(numero);
      await e.servicios.correos.esperarDespachos();
      await verificar(numero, codigoDe(e.mailer.ultimo().text));
      const b = await e.pool.query(
        `SELECT accion, detalle, ip FROM bitacora WHERE modulo = 'consulta' ORDER BY id DESC LIMIT 2`,
      );
      expect(b.rows.map((x) => x.accion)).toEqual([
        'CONSULTA_ACCESO',
        'CONSULTA_CODIGO_SOLICITADO',
      ]);
      expect(b.rows[0].detalle).toEqual({ medio: 'CODIGO' });
      expect(b.rows[0].ip).toBeTruthy();
    });
  });

  describe('enlace seguro de las notificaciones', () => {
    it('permite consultar el estado con el enlace, también varias veces', async () => {
      const { enlaceSeguro } = await solicitud();
      for (let i = 0; i < 2; i++) {
        const s = await request(e.app).post(`${pub}/consulta/enlace`).send({ token: enlaceSeguro });
        expect(s.status).toBe(200);
        expect((await consultar(s.body.token)).body.estado.nombre).toBe('Correo verificado');
      }
      const b = await e.pool.query(
        `SELECT detalle FROM bitacora WHERE accion = 'CONSULTA_ACCESO' ORDER BY id DESC LIMIT 1`,
      );
      expect(b.rows[0].detalle).toEqual({ medio: 'ENLACE' });
    });

    it('rechaza un enlace inventado, uno de otro propósito y uno vencido', async () => {
      const malo = await request(e.app)
        .post(`${pub}/consulta/enlace`)
        .send({ token: 'x'.repeat(43) });
      expect(malo.status).toBe(401);
      expect(malo.body.error.codigo).toBe('ENLACE_INVALIDO');
      // El enlace de verificación del correo no da acceso a la consulta.
      const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body as Formulario;
      adelantar(1);
      consecutivo += 2;
      await request(e.app)
        .post(`${pub}/preinscripciones`)
        .send({
          pcdNombre: 'Otra Persona',
          pcdTipoIdentificacionId: cc,
          pcdNumero: String(consecutivo),
          cuidadorNombre: 'Cuidador Uno',
          cuidadorTipoIdentificacionId: cc,
          cuidadorNumero: String(consecutivo + 1),
          correo: 'x@correo.com',
          aceptaAutorizacion: true,
          autorizacionVersion: f.autorizacion.version,
          formularioToken: f.formularioToken,
        });
      await e.servicios.correos.esperarDespachos();
      const deVerificacion = tokenDe(e.mailer.ultimo().text);
      expect(
        (await request(e.app).post(`${pub}/consulta/enlace`).send({ token: deVerificacion }))
          .status,
      ).toBe(401);

      const { enlaceSeguro } = await solicitud();
      adelantar(91 * 24 * 60);
      const vencido = await request(e.app)
        .post(`${pub}/consulta/enlace`)
        .send({ token: enlaceSeguro });
      expect(vencido.status).toBe(401);
      expect(vencido.body.error.codigo).toBe('ENLACE_VENCIDO');
    });
  });

  describe('protección del acceso', () => {
    it('sin sesión o con un token falso nunca se muestra información de la solicitud', async () => {
      expect((await request(e.app).get(`${pub}/consulta/solicitud`)).status).toBe(401);
      expect((await consultar('token-falso')).status).toBe(401);
    });

    it('el token del formulario o el de un usuario interno no sirven para consultar', async () => {
      const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body as Formulario;
      expect((await consultar(f.formularioToken)).status).toBe(401);
      const interno = e.deps.tokens.firmarInterno(
        { sub: 1, tv: 0, cambiarPassword: false, sid: 'x' },
        10,
      );
      expect((await consultar(interno)).status).toBe(401);
    });

    it('cada sesión solo da acceso a su propia solicitud', async () => {
      const a = await solicitud({ correo: 'a@correo.com' });
      const b = await solicitud({ correo: 'b@correo.com' });
      const sa = await request(e.app)
        .post(`${pub}/consulta/enlace`)
        .send({ token: a.enlaceSeguro });
      const sb = await request(e.app)
        .post(`${pub}/consulta/enlace`)
        .send({ token: b.enlaceSeguro });
      const ra = (await consultar(sa.body.token)).body;
      const rb = (await consultar(sb.body.token)).body;
      expect(ra.correo).toMatch(/^a\*+@/);
      expect(rb.correo).toMatch(/^b\*+@/);
    });

    it('limita los intentos de acceso por conexión', async () => {
      const { app } = crearAplicacion(e.deps, { limitarIntentos: true });
      let ultimo = 0;
      for (let i = 0; i < 21; i++) {
        ultimo = (
          await request(app)
            .post(`${pub}/consulta/enlace`)
            .send({ token: 'x'.repeat(43) })
        ).status;
      }
      expect(ultimo).toBe(429);
    });
  });
});
