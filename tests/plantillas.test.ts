import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { renderizar, validarPlantilla, valoresDeCorreo } from '../src/domain/correos.js';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';

const api = '/api/v1/admin';
const pub = '/api/v1/publico';

describe('plantillas de correo configurables (RF-COM-02, RNF-12)', () => {
  let e: Entorno;
  let admin: CuentaPrueba;
  let cc: number;
  let consecutivo = 5_000_000;

  beforeAll(async () => {
    e = await crearEntorno();
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
    cc = f.tiposIdentificacion.find((t: { codigo: string }) => t.codigo === 'CC').id;
  });
  afterAll(async () => {
    await e.cerrar();
  });
  beforeEach(async () => {
    await e.servicios.correos.esperarDespachos();
    e.mailer.enviados.length = 0;
    e.reloj.ahora = new Date();
  });

  const get = (ruta: string, c = admin) => request(e.app).get(`${api}${ruta}`).set(auth(c));
  const post = (ruta: string, cuerpo: object = {}, c = admin) =>
    request(e.app).post(`${api}${ruta}`).set(auth(c)).send(cuerpo);

  /** Preinscribe a una persona (envía el correo de verificación con la plantilla vigente). */
  async function preinscribir() {
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body;
    e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 20_000);
    consecutivo += 2;
    const r = await request(e.app)
      .post(`${pub}/preinscripciones`)
      .send({
        pcdNombre: 'María Fernanda Pérez',
        pcdTipoIdentificacionId: cc,
        pcdNumero: String(consecutivo),
        cuidadorNombre: 'Carlos López',
        cuidadorTipoIdentificacionId: cc,
        cuidadorNumero: String(consecutivo + 1),
        correo: 'familia@correo.com',
        correoConfirmacion: 'familia@correo.com',
        aceptaAutorizacion: true,
        autorizacionVersion: f.autorizacion.version,
        formularioToken: f.formularioToken,
      });
    expect(r.status).toBe(201);
    await e.servicios.correos.esperarDespachos();
  }

  describe('permisos', () => {
    it('solo quien tiene el permiso las administra, también por la API directa', async () => {
      const analista = await crearCuenta(e, 'ANALISTA');
      for (const ruta of ['/plantillas', '/plantillas/PREINSCRIPCION_EXITOSA']) {
        expect((await get(ruta, analista)).status, ruta).toBe(403);
      }
      expect(
        (
          await post(
            '/plantillas/PREINSCRIPCION_EXITOSA/vista-previa',
            { asunto: 'Asunto de prueba', cuerpo: 'x'.repeat(30) },
            analista,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(
            '/plantillas/PREINSCRIPCION_EXITOSA/versiones',
            { asunto: 'Asunto de prueba', cuerpo: 'x'.repeat(30) },
            analista,
          )
        ).status,
      ).toBe(403);
      expect((await request(e.app).get(`${api}/plantillas`)).status).toBe(401);
    });
  });

  describe('consulta', () => {
    it('trae las plantillas de las notificaciones del programa, cada una con su versión vigente', async () => {
      const lista = (await get('/plantillas')).body.items as { codigo: string; version: number }[];
      expect(lista.map((p) => p.codigo).sort()).toEqual([
        'CARACTERIZACION_RADICADA',
        'CODIGO_CONSULTA',
        'CUENTA_CREADA',
        'PASSWORD_RESTABLECIDA',
        'PREINSCRIPCION_EXITOSA',
        'PREINSCRIPCION_VERIFICACION',
        'SUBSANACION_RECIBIDA',
        'VALIDACION_APROBADA',
        'VALIDACION_RECHAZADA',
        'VALIDACION_SUBSANACION',
      ]);
      expect(lista.every((p) => p.version === 1)).toBe(true);
    });

    it('cada plantilla trae sus variables (con su descripción y si son obligatorias) y todas incluyen la aclaración de que no es aprobación', async () => {
      for (const codigo of [
        'PREINSCRIPCION_VERIFICACION',
        'PREINSCRIPCION_EXITOSA',
        'CARACTERIZACION_RADICADA',
        'CODIGO_CONSULTA',
      ]) {
        const p = (await get(`/plantillas/${codigo}`)).body;
        expect(p.vigente.cuerpo, codigo).toContain('{{aviso_preinscripcion}}');
        const aviso = p.variables.find(
          (v: { nombre: string }) => v.nombre === 'aviso_preinscripcion',
        );
        expect(aviso.obligatoria, codigo).toBe(true);
        expect(aviso.descripcion).toContain('no equivale a la aprobación');
      }
      const rad = (await get('/plantillas/CARACTERIZACION_RADICADA')).body;
      expect(rad.variables.map((v: { nombre: string }) => v.nombre)).toEqual(
        expect.arrayContaining([
          'nombre',
          'radicado',
          'estado',
          'siguiente_paso',
          'enlace_consulta',
        ]),
      );
    });
  });

  describe('vista previa', () => {
    it('reemplaza las variables con datos de ejemplo antes de guardar', async () => {
      const r = await post('/plantillas/CARACTERIZACION_RADICADA/vista-previa', {
        asunto: 'Radicado {{radicado}}',
        cuerpo:
          'Hola. Radicado {{radicado}} de {{nombre}}. {{estado}}. {{siguiente_paso}} {{enlace_consulta}} {{aviso_preinscripcion}}',
      });
      expect(r.status).toBe(200);
      expect(r.body.asunto).toBe('Radicado EST-2026-000123');
      expect(r.body.cuerpo).toContain('de María Pérez');
      expect(r.body.cuerpo).toContain('no equivale a la aprobación del beneficio');
      expect(r.body.problemas).toEqual([]);
    });

    it('señala las variables desconocidas y las obligatorias que faltan, sin fallar', async () => {
      const r = await post('/plantillas/CARACTERIZACION_RADICADA/vista-previa', {
        asunto: 'Radicado {{radicado}}',
        cuerpo: 'Hola {{nombre}}, su radicado es {{radicado}} y {{inventada}}.',
      });
      expect(r.status).toBe(200);
      expect(r.body.cuerpo).toContain('{{inventada}}');
      const problemas = r.body.problemas.join(' | ');
      expect(problemas).toContain('{{inventada}}');
      expect(problemas).toContain('{{enlace_consulta}}');
      expect(problemas).toContain('{{aviso_preinscripcion}}');
    });

    it('no permite usar en una plantilla variables de otra (por ejemplo el radicado en la verificación)', async () => {
      const r = await post('/plantillas/PREINSCRIPCION_VERIFICACION/vista-previa', {
        asunto: 'Verifique su correo {{radicado}}',
        cuerpo: 'Enlace {{enlace_verificacion}} {{aviso_preinscripcion}}',
      });
      expect(r.body.problemas.join(' ')).toContain('{{radicado}}');
    });

    it('exige asunto y texto', async () => {
      const r = await post('/plantillas/PREINSCRIPCION_EXITOSA/vista-previa', {
        asunto: '',
        cuerpo: '',
      });
      expect(r.status).toBe(422);
    });
  });

  describe('guardar una versión nueva', () => {
    const textoCompleto = (extra = '') =>
      `Hola:\n\nSu correo fue verificado y la preinscripción de {{nombre}} quedó registrada.${extra}\n\nEstado: {{estado}}\nSiguiente paso: {{siguiente_paso}}\nCaracterización: {{enlace_caracterizacion}}\nConsulta: {{enlace_consulta}}\n\n{{aviso_preinscripcion}}`;

    it('no guarda un texto sin las variables obligatorias y lo explica', async () => {
      const r = await post('/plantillas/PREINSCRIPCION_EXITOSA/versiones', {
        asunto: 'Preinscripción exitosa',
        cuerpo:
          'Hola {{nombre}}, su preinscripción quedó registrada. Gracias por participar en el programa.',
      });
      expect(r.status).toBe(422);
      const mensajes = r.body.error.errores.map((x: { mensaje: string }) => x.mensaje).join(' | ');
      expect(mensajes).toContain('{{enlace_consulta}}');
      expect(mensajes).toContain('{{aviso_preinscripcion}}');
      expect((await get('/plantillas/PREINSCRIPCION_EXITOSA')).body.versiones).toHaveLength(1);
    });

    it('no guarda variables desconocidas ni un asunto de varias líneas', async () => {
      const desconocida = await post('/plantillas/PREINSCRIPCION_EXITOSA/versiones', {
        asunto: 'Preinscripción exitosa {{secreto}}',
        cuerpo: textoCompleto(),
      });
      expect(desconocida.status).toBe(422);
      expect(JSON.stringify(desconocida.body)).toContain('{{secreto}}');
      const lineas = await post('/plantillas/PREINSCRIPCION_EXITOSA/versiones', {
        asunto: 'Primera línea\nSegunda línea',
        cuerpo: textoCompleto(),
      });
      expect(lineas.status).toBe(422);
      expect(JSON.stringify(lineas.body)).toContain('una sola línea');
    });

    it('guarda la versión nueva con autor, motivo y fecha, y conserva la anterior', async () => {
      const antes = (await get('/plantillas/PREINSCRIPCION_EXITOSA')).body.vigente;
      const r = await post('/plantillas/PREINSCRIPCION_EXITOSA/versiones', {
        asunto: 'Preinscripción registrada · Estímulo Social de Transporte',
        cuerpo: textoCompleto(' ¡Gracias por participar!'),
        justificacion: 'Ajuste de redacción',
      });
      expect(r.status).toBe(201);
      expect(r.body.version).toBe(2);
      const p = (await get('/plantillas/PREINSCRIPCION_EXITOSA')).body;
      expect(p.versiones.map((v: { version: number }) => v.version)).toEqual([2, 1]);
      expect(p.vigente).toMatchObject({
        version: 2,
        creadoPor: admin.usuario,
        justificacion: 'Ajuste de redacción',
      });
      expect(p.versiones[1].cuerpo).toBe(antes.cuerpo);
      const b = await e.pool.query(
        `SELECT valor_anterior, valor_nuevo, justificacion FROM bitacora WHERE accion = 'PLANTILLA_VERSION_CREADA' ORDER BY id DESC LIMIT 1`,
      );
      expect(b.rows[0].valor_anterior.version).toBe(1);
      expect(b.rows[0].valor_nuevo.version).toBe(2);
      expect(b.rows[0].justificacion).toBe('Ajuste de redacción');
    });

    it('rechaza guardar un texto idéntico al vigente', async () => {
      const v = (await get('/plantillas/PREINSCRIPCION_EXITOSA')).body.vigente;
      const r = await post('/plantillas/PREINSCRIPCION_EXITOSA/versiones', {
        asunto: v.asunto,
        cuerpo: v.cuerpo,
      });
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('SIN_CAMBIO');
    });

    it('dos guardados simultáneos generan versiones distintas y consecutivas', async () => {
      const mk = (n: number) =>
        post('/plantillas/CODIGO_CONSULTA/versiones', {
          asunto: `Su código de consulta ${n}`,
          cuerpo: `Código para {{nombre}}: {{codigo}}. Vale {{minutos_vigencia}} minutos. {{aviso_preinscripcion}} (${n})`,
        });
      const [a, b] = await Promise.all([mk(1), mk(2)]);
      expect([a.status, b.status]).toEqual([201, 201]);
      expect([a.body.version, b.body.version].sort()).toEqual([2, 3]);
    });

    it('las versiones son inmutables y las plantillas inexistentes o mal escritas responden con error claro', async () => {
      await expect(e.pool.query(`UPDATE plantilla_versiones SET cuerpo = 'x'`)).rejects.toThrow(
        /inmutable/,
      );
      await expect(e.pool.query(`DELETE FROM plantilla_versiones`)).rejects.toThrow(/inmutable/);
      expect((await get('/plantillas/NO_EXISTE')).status).toBe(404);
      expect((await get('/plantillas/no-valida')).status).toBe(400);
    });
  });

  describe('efecto en los correos', () => {
    it('el correo siguiente sale con la versión nueva y el anterior conserva su texto exacto y su versión', async () => {
      await preinscribir();
      const antes = (
        await e.pool.query(`SELECT plantilla_version, cuerpo FROM correos ORDER BY id DESC LIMIT 1`)
      ).rows[0];
      expect(antes.plantilla_version).toBe(1);
      const guardada = await post('/plantillas/PREINSCRIPCION_VERIFICACION/versiones', {
        asunto: 'Confirme su correo electrónico',
        cuerpo:
          'Estimado ciudadano: confirme el correo de {{nombre}} aquí: {{enlace_verificacion}} (vale {{horas_vigencia}} h).\n\n{{aviso_preinscripcion}}',
        justificacion: 'Texto más corto',
      });
      expect(guardada.status).toBe(201);
      await preinscribir();
      const m = e.mailer.ultimo();
      expect(m.subject).toBe('Confirme su correo electrónico');
      expect(m.text).toContain(
        'Estimado ciudadano: confirme el correo de María Fernanda Pérez aquí: http://localhost:4300/verificar-correo?token=',
      );
      expect(m.text).toContain('no equivale a la aprobación del beneficio');
      const filas = (
        await e.pool.query(
          `SELECT plantilla_version, cuerpo, asunto FROM correos ORDER BY id DESC LIMIT 2`,
        )
      ).rows;
      expect(filas[0]).toMatchObject({
        plantilla_version: 2,
        asunto: 'Confirme su correo electrónico',
      });
      expect(filas[1].plantilla_version).toBe(1);
      expect(filas[1].cuerpo).toBe(antes.cuerpo);
    });

    it('cada correo queda enlazado a una versión que existe (no se puede registrar con una inexistente)', async () => {
      await expect(
        e.pool.query(
          `INSERT INTO correos (tipo, plantilla_version, destinatario, asunto, cuerpo) VALUES ('CODIGO_CONSULTA', 99, 'a@b.co', 'Asunto de prueba', 'Cuerpo de prueba')`,
        ),
      ).rejects.toThrow(/correos_plantilla_fk/);
      await expect(
        e.pool.query(`UPDATE correos SET plantilla_version = 1 WHERE plantilla_version = 2`),
      ).rejects.toThrow(/inmutable/);
    });

    it('nunca se envía un correo con una variable en blanco', async () => {
      await expect(
        e.servicios.correos.encolar(e.pool, {
          solicitudId: null,
          tipo: 'CARACTERIZACION_RADICADA',
          destinatario: 'a@b.co',
          datos: { nombre: 'María' },
        }),
      ).rejects.toThrow(/Falta el valor de la variable/);
    });
  });

  describe('motor de variables', () => {
    it('quita los saltos de línea del asunto (no se pueden inyectar cabeceras)', () => {
      expect(renderizar('Hola {{nombre}}', { nombre: 'Ana\r\nBcc: x@y.co' }, true)).toBe(
        'Hola Ana Bcc: x@y.co',
      );
    });

    it('acepta espacios dentro de las llaves y repite una variable usada varias veces', () => {
      expect(renderizar('{{ nombre }} y {{nombre}}', { nombre: 'Ana' })).toBe('Ana y Ana');
    });

    it('valida variables permitidas y obligatorias', () => {
      const def = { permitidas: ['nombre', 'estado'], obligatorias: ['estado'] };
      expect(validarPlantilla(def, 'Hola', 'Su {{estado}}')).toEqual([]);
      expect(validarPlantilla(def, 'Hola {{x}}', 'Su {{nombre}}')).toHaveLength(2);
    });

    it('arma los valores a partir de los datos y siempre incluye la aclaración', () => {
      const v = valoresDeCorreo({ nombre: 'Ana', horasVigencia: 72 });
      expect(v).toMatchObject({ nombre: 'Ana', horas_vigencia: '72' });
      expect(v.aviso_preinscripcion).toContain('no equivale a la aprobación');
      expect(v.radicado).toBeUndefined();
    });
  });
});
