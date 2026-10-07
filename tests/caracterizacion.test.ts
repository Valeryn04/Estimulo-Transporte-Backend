import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { calcularAvance, datosVacios, normalizarTelefono } from '../src/domain/caracterizacion.js';
import { correccionesRepo } from '../src/infrastructure/repositories/caracterizacion.js';
import { DataCipher } from '../src/infrastructure/security/crypto.js';
import { crearEntorno, type Entorno } from './helpers.js';

const pub = '/api/v1/publico';

interface Item {
  id: number;
  codigo: string;
  nombre: string;
}
interface Formulario {
  tiposIdentificacion: Item[];
  autorizacion: { version: number };
  formularioToken: string;
}
type Respuesta = Awaited<ReturnType<Entorno['servicios']['caracterizacion']['obtener']>>;

describe('caracterización de la PCD y del cuidador (RF-CAR-01, RF-CAR-02, RF-CAR-04, RNF-10)', () => {
  let e: Entorno;
  let cc: number;
  let consecutivo = 7_000_000;

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

  /** Preinscribe, verifica el correo y abre la sesión del ciudadano con el enlace seguro. */
  async function persona(opciones: { cuidadorNumero?: string; verificar?: boolean } = {}) {
    const f = (await request(e.app).get(`${pub}/preinscripcion/formulario`)).body as Formulario;
    e.reloj.ahora = new Date(e.reloj.ahora.getTime() + 60_000);
    consecutivo += 2;
    const cuidadorNumero = opciones.cuidadorNumero ?? String(consecutivo + 1);
    const r = await request(e.app)
      .post(`${pub}/preinscripciones`)
      .send({
        pcdNombre: 'María Fernanda Pérez',
        pcdTipoIdentificacionId: cc,
        pcdNumero: String(consecutivo),
        cuidadorNombre: 'Carlos López',
        cuidadorTipoIdentificacionId: cc,
        cuidadorNumero,
        correo: 'familia@correo.com',
        aceptaAutorizacion: true,
        autorizacionVersion: f.autorizacion.version,
        formularioToken: f.formularioToken,
      });
    expect(r.status).toBe(201);
    await e.servicios.correos.esperarDespachos();
    const solicitudId = (
      await e.pool.query<{ id: number }>(
        `SELECT s.id FROM solicitudes s JOIN personas p ON p.id = s.pcd_id WHERE p.numero_identificacion = $1`,
        [String(consecutivo)],
      )
    ).rows[0]!.id;
    if (opciones.verificar === false) {
      return { solicitudId, token: e.deps.tokens.firmarCiudadano(solicitudId, 30) };
    }
    await request(e.app)
      .post(`${pub}/preinscripciones/verificar-correo`)
      .send({ token: tokenDe(e.mailer.ultimo().text) });
    await e.servicios.correos.esperarDespachos();
    const enlace = tokenDe(e.mailer.ultimo().text);
    const sesion = await request(e.app).post(`${pub}/consulta/enlace`).send({ token: enlace });
    expect(sesion.status).toBe(200);
    e.mailer.enviados.length = 0;
    return { solicitudId, token: sesion.body.token as string };
  }

  const ver = (token: string) =>
    request(e.app).get(`${pub}/caracterizacion`).set('Authorization', `Bearer ${token}`);
  const guardar = (token: string, cuerpo: object) =>
    request(e.app)
      .patch(`${pub}/caracterizacion`)
      .set('Authorization', `Bearer ${token}`)
      .send(cuerpo);
  const idDe = (lista: Item[], codigo: string) => lista.find((i) => i.codigo === codigo)!.id;

  /** Datos completos de una persona que sí requiere cuidador. */
  const completo = (c: Respuesta['catalogos']) => ({
    generoId: idDe(c.generos, 'FEMENINO'),
    celular: '300 123 4567',
    ocupacionId: idDe(c.ocupaciones, 'DESEMPLEADO'),
    epsId: idDe(c.eps, 'SANITAS'),
    embarazo: 'NO',
    recibeSubsidios: false,
    requiereCuidador: true,
    cuidadorGeneroId: idDe(c.generos, 'MASCULINO'),
    cuidadorCelular: '3109876543',
    cuidadorCorreo: 'carlos@correo.com',
  });

  describe('acceso', () => {
    it('exige la sesión del ciudadano', async () => {
      expect((await request(e.app).get(`${pub}/caracterizacion`)).status).toBe(401);
      expect(
        (await request(e.app).patch(`${pub}/caracterizacion`).send({ version: 0 })).status,
      ).toBe(401);
      expect((await ver('token-invalido')).status).toBe(401);
    });

    it('cada persona solo ve y cambia su propia solicitud', async () => {
      const a = await persona();
      const b = await persona();
      await guardar(a.token, { version: 0, celular: '3001112222' });
      const deB = (await ver(b.token)).body;
      expect(deB.datos.celular).toBeNull();
      expect(deB.pcd.numero).not.toBe((await ver(a.token)).body.pcd.numero);
    });

    it('una solicitud con el correo sin verificar no se puede editar', async () => {
      const p = await persona({ verificar: false });
      const r = await guardar(p.token, { version: 0, celular: '3001112222' });
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('SOLICITUD_NO_EDITABLE');
      expect((await ver(p.token)).body.solicitud.editable).toBe(false);
    });
  });

  describe('formulario precargado (RF-CAR-01)', () => {
    it('trae los datos de la preinscripción, los catálogos administrables y el avance en cero', async () => {
      const p = await persona();
      const r = await ver(p.token);
      expect(r.status).toBe(200);
      expect(r.body.pcd).toMatchObject({
        nombre: 'María Fernanda Pérez',
        tipoIdentificacion: { codigo: 'CC' },
        correo: 'familia@correo.com',
      });
      expect(r.body.cuidador).toMatchObject({ nombre: 'Carlos López', nombreEditable: true });
      expect(r.body.version).toBe(0);
      expect(r.body.guardadoAt).toBeNull();
      expect(r.body.solicitud).toMatchObject({
        editable: true,
        estado: { codigo: 'CORREO_VERIFICADO' },
      });
      const c = r.body.catalogos as Respuesta['catalogos'];
      expect(c.generos.map((g) => g.nombre)).toEqual(['Femenino', 'Masculino', 'Otro', 'N/A']);
      expect(c.estadosCiviles).toHaveLength(6);
      expect(c.etnias.map((x) => x.nombre)).toContain('Raizal');
      expect(c.escolaridades.at(0)?.nombre).toBe('Educación inicial');
      expect(c.escolaridades.map((x) => x.nombre)).toContain('Doctorado');
      expect(c.ocupaciones.map((x) => x.nombre)).toContain('Ama de casa');
      expect(c.tiposTransporte.map((x) => x.nombre)).toEqual(['Transmetro', 'SiBus']);
      expect(c.eps.length).toBeGreaterThan(0);
      expect(r.body.avance).toMatchObject({ completados: 0, porcentaje: 0, completa: false });
      // Sin cuidador marcado todavía, la sección del cuidador no aparece (RF-CAR-02).
      expect(r.body.avance.secciones.map((s: { codigo: string }) => s.codigo)).toEqual([
        'datos-personales',
        'situacion',
        'salud-apoyos',
        'transporte',
      ]);
    });
  });

  describe('guardado de avance (RF-CAR-04)', () => {
    it('guarda datos a medias y los devuelve al retomar, con el avance calculado', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      const r = await guardar(p.token, {
        version: 0,
        generoId: idDe(c.generos, 'FEMENINO'),
        celular: '+57 300 123 4567',
        telefonoFijo: '605 123 4567',
        fechaNacimiento: '1985-04-12',
        estadoCivilId: idDe(c.estadosCiviles, 'SOLTERO'),
      });
      expect(r.status).toBe(200);
      expect(r.body.version).toBe(1);
      expect(r.body.datos).toMatchObject({
        celular: '3001234567',
        telefonoFijo: '6051234567',
        fechaNacimiento: '1985-04-12',
      });
      expect(r.body.avance.secciones[0]).toMatchObject({
        requeridos: 2,
        completados: 2,
        completa: true,
      });
      expect(r.body.avance.porcentaje).toBeGreaterThan(0);
      // Al volver (otro dispositivo, otro día) está todo lo que se escribió.
      const otra = await ver(p.token);
      expect(otra.body.datos).toMatchObject({
        celular: '3001234567',
        fechaNacimiento: '1985-04-12',
      });
      expect(otra.body.version).toBe(1);
      expect(otra.body.guardadoAt).not.toBeNull();
    });

    it('guardar lo mismo otra vez no crea una versión nueva', async () => {
      const p = await persona();
      const a = await guardar(p.token, { version: 0, celular: '3001112222' });
      const b = await guardar(p.token, { version: 1, celular: '3001112222' });
      expect(a.body.version).toBe(1);
      expect(b.body.version).toBe(1);
    });

    it('una pestaña desactualizada no pisa lo guardado en otra', async () => {
      const p = await persona();
      await guardar(p.token, { version: 0, celular: '3001112222' });
      const r = await guardar(p.token, { version: 0, celular: '3009998888' });
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('CONFLICTO_VERSION');
      expect((await ver(p.token)).body.datos.celular).toBe('3001112222');
    });

    it('dos guardados simultáneos con la misma versión: solo uno gana', async () => {
      const p = await persona();
      const [a, b] = await Promise.all([
        guardar(p.token, { version: 0, celular: '3001112222' }),
        guardar(p.token, { version: 0, celular: '3009998888' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
    });

    it('permite borrar un dato ya escrito', async () => {
      const p = await persona();
      await guardar(p.token, { version: 0, celular: '3001112222', telefonoFijo: '6051234567' });
      const r = await guardar(p.token, { version: 1, telefonoFijo: null });
      expect(r.body.datos.telefonoFijo).toBeNull();
      expect(r.body.datos.celular).toBe('3001112222');
    });

    it('registra en la bitácora qué campos cambiaron, sin copiar sus valores', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      await guardar(p.token, {
        version: 0,
        celular: '3001112222',
        epsId: idDe(c.eps, 'SANITAS'),
        recibeSubsidios: true,
        subsidioCual: 'Colombia Mayor',
      });
      const b = await e.pool.query(
        `SELECT detalle, valor_anterior, valor_nuevo FROM bitacora
          WHERE accion = 'CARACTERIZACION_GUARDADA' AND solicitud_id = $1`,
        [p.solicitudId],
      );
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0].detalle.campos).toEqual(
        expect.arrayContaining(['celular', 'epsId', 'recibeSubsidios', 'subsidioCual']),
      );
      expect(JSON.stringify(b.rows[0])).not.toContain('Colombia Mayor');
      expect(JSON.stringify(b.rows[0])).not.toContain('3001112222');
    });
  });

  describe('validaciones de formato y de catálogo (RNF-10)', () => {
    it('rechaza teléfonos mal escritos con un mensaje que explica cómo corregirlos', async () => {
      const p = await persona();
      const r = await guardar(p.token, { version: 0, celular: '12345', telefonoFijo: '99' });
      expect(r.status).toBe(422);
      const errores = r.body.error.errores as { campo: string; mensaje: string }[];
      expect(errores.find((x) => x.campo === 'celular')?.mensaje).toContain('empiece por 3');
      expect(errores.find((x) => x.campo === 'telefonoFijo')?.mensaje).toContain('7 dígitos');
      expect((await ver(p.token)).body.version).toBe(0);
    });

    it('rechaza fechas inválidas, futuras o demasiado antiguas', async () => {
      const p = await persona();
      for (const fecha of ['2026-02-30', 'ayer', '2999-01-01', '1850-05-05']) {
        const r = await guardar(p.token, { version: 0, fechaNacimiento: fecha });
        expect(r.status, fecha).toBe(422);
        expect(r.body.error.errores[0].campo).toBe('fechaNacimiento');
      }
    });

    it('las listas son cerradas: no acepta opciones de otro catálogo ni inexistentes', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      const delOtro = await guardar(p.token, { version: 0, generoId: c.eps[0]!.id });
      expect(delOtro.status).toBe(422);
      expect(delOtro.body.error.errores[0]).toMatchObject({ campo: 'generoId' });
      expect((await guardar(p.token, { version: 0, epsId: 999_999 })).status).toBe(422);
      expect((await guardar(p.token, { version: 0, epsId: 'x' })).status).toBe(422);
    });

    it('una opción desactivada ya no se puede elegir, pero la que ya estaba guardada se sigue mostrando', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      const sanitas = idDe(c.eps, 'SANITAS');
      await guardar(p.token, { version: 0, epsId: sanitas });
      await e.pool.query(`UPDATE catalogo_items SET activo = false WHERE id = $1`, [sanitas]);
      const despues = await ver(p.token);
      expect(despues.body.datos.epsId).toBe(sanitas);
      expect(despues.body.catalogos.eps.map((x: Item) => x.id)).toContain(sanitas);
      const otra = await persona();
      expect((await guardar(otra.token, { version: 0, epsId: sanitas })).status).toBe(422);
      await e.pool.query(`UPDATE catalogo_items SET activo = true WHERE id = $1`, [sanitas]);
    });

    it('no acepta campos que no existen', async () => {
      const p = await persona();
      const r = await guardar(p.token, { version: 0, rol: 'ADMINISTRADOR' });
      expect(r.status).toBe(422);
    });

    it('exige la versión', async () => {
      const p = await persona();
      expect((await guardar(p.token, { celular: '3001112222' })).status).toBe(422);
    });
  });

  describe('campos condicionales (RF-CAR-01, RF-CAR-02)', () => {
    it('hijos: pide cantidad y una edad por hijo, y los borra si dice que no tiene', async () => {
      const p = await persona();
      const r = await guardar(p.token, {
        version: 0,
        tieneHijos: true,
        hijosCantidad: 2,
        hijosEdades: [7, null],
      });
      expect(r.body.datos).toMatchObject({
        tieneHijos: true,
        hijosCantidad: 2,
        hijosEdades: [7, null],
      });
      const sec = r.body.avance.secciones.find((s: { codigo: string }) => s.codigo === 'situacion');
      expect(sec.faltantes.map((f: { campo: string }) => f.campo)).toContain('hijosEdades');
      const desigual = await guardar(p.token, {
        version: 1,
        hijosCantidad: 3,
        hijosEdades: [7, 9],
      });
      expect(desigual.status).toBe(422);
      const mas = await guardar(p.token, { version: 1, hijosCantidad: 3 });
      expect(mas.body.datos.hijosEdades).toEqual([7, null, null]);
      const no = await guardar(p.token, { version: 2, tieneHijos: false });
      expect(no.body.datos).toMatchObject({
        tieneHijos: false,
        hijosCantidad: null,
        hijosEdades: null,
      });
    });

    it('hijos: rechaza cantidades y edades fuera de rango', async () => {
      const p = await persona();
      expect((await guardar(p.token, { version: 0, hijosCantidad: 0 })).status).toBe(422);
      expect((await guardar(p.token, { version: 0, hijosCantidad: 21 })).status).toBe(422);
      expect((await guardar(p.token, { version: 0, hijosEdades: [101] })).status).toBe(422);
      expect((await guardar(p.token, { version: 0, hijosEdades: [-1] })).status).toBe(422);
    });

    it('gestación: solo aplica si está embarazada y no es coherente con el género masculino', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      const si = await guardar(p.token, {
        version: 0,
        generoId: idDe(c.generos, 'FEMENINO'),
        embarazo: 'SI',
        semanasGestacion: 20,
      });
      expect(si.body.datos).toMatchObject({ embarazo: 'SI', semanasGestacion: 20 });
      const falta = await guardar(p.token, { version: 1, semanasGestacion: null });
      const salud = falta.body.avance.secciones.find(
        (s: { codigo: string }) => s.codigo === 'salud-apoyos',
      );
      expect(salud.faltantes.map((f: { campo: string }) => f.campo)).toContain('semanasGestacion');
      const no = await guardar(p.token, { version: 2, embarazo: 'NO' });
      expect(no.body.datos.semanasGestacion).toBeNull();
      expect((await guardar(p.token, { version: 3, semanasGestacion: 43 })).status).toBe(422);
      const masculino = await guardar(p.token, {
        version: 3,
        generoId: idDe(c.generos, 'MASCULINO'),
        embarazo: 'SI',
        semanasGestacion: 10,
      });
      expect(masculino.status).toBe(422);
      expect(masculino.body.error.errores[0].campo).toBe('embarazo');
    });

    it('subsidios: pide cuál solo si recibe otros y lo borra si dice que no', async () => {
      const p = await persona();
      const si = await guardar(p.token, { version: 0, recibeSubsidios: true });
      const salud = si.body.avance.secciones.find(
        (s: { codigo: string }) => s.codigo === 'salud-apoyos',
      );
      expect(salud.faltantes.map((f: { campo: string }) => f.campo)).toContain('subsidioCual');
      const con = await guardar(p.token, { version: 1, subsidioCual: 'Colombia Mayor' });
      expect(con.body.datos.subsidioCual).toBe('Colombia Mayor');
      const no = await guardar(p.token, { version: 2, recibeSubsidios: false });
      expect(no.body.datos.subsidioCual).toBeNull();
    });

    it('cuidador: la sección aparece solo si requiere el servicio y sus datos se borran si deja de requerirlo', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      const si = await guardar(p.token, { version: 0, requiereCuidador: true });
      const codigos = si.body.avance.secciones.map((s: { codigo: string }) => s.codigo);
      expect(codigos).toContain('cuidador');
      const cuidador = si.body.avance.secciones.find(
        (s: { codigo: string }) => s.codigo === 'cuidador',
      );
      expect(cuidador.faltantes.map((f: { campo: string }) => f.campo)).toEqual([
        'cuidadorGeneroId',
        'cuidadorCelular',
        'cuidadorCorreo',
      ]);
      const datos = await guardar(p.token, {
        version: 1,
        cuidadorGeneroId: idDe(c.generos, 'MASCULINO'),
        cuidadorCelular: '3109876543',
        cuidadorCorreo: 'carlos@correo.com',
        cuidadorTelefonoFijo: '6054445566',
      });
      expect(
        datos.body.avance.secciones.find((s: { codigo: string }) => s.codigo === 'cuidador')
          .completa,
      ).toBe(true);
      const no = await guardar(p.token, { version: 2, requiereCuidador: false });
      expect(no.body.datos).toMatchObject({
        requiereCuidador: false,
        cuidadorGeneroId: null,
        cuidadorCelular: null,
        cuidadorCorreo: null,
        cuidadorTelefonoFijo: null,
      });
      expect(no.body.avance.secciones.map((s: { codigo: string }) => s.codigo)).not.toContain(
        'cuidador',
      );
    });

    it('cuidador: valida el correo y el celular del cuidador', async () => {
      const p = await persona();
      const r = await guardar(p.token, {
        version: 0,
        requiereCuidador: true,
        cuidadorCorreo: 'sin-arroba',
        cuidadorCelular: '123',
      });
      expect(r.status).toBe(422);
      const campos = r.body.error.errores.map((x: { campo: string }) => x.campo);
      expect(campos).toEqual(expect.arrayContaining(['cuidadorCorreo', 'cuidadorCelular']));
    });
  });

  describe('avance por secciones (RF-CAR-01)', () => {
    it('llega a 100 % solo con todos los datos obligatorios', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      const parcial = await guardar(p.token, { version: 0, generoId: idDe(c.generos, 'FEMENINO') });
      expect(parcial.body.avance.completa).toBe(false);
      expect(parcial.body.avance.porcentaje).toBeLessThan(100);
      const todo = await guardar(p.token, { version: 1, ...completo(c) });
      expect(todo.status).toBe(200);
      expect(todo.body.avance).toMatchObject({ porcentaje: 100, completa: true });
      expect(
        todo.body.avance.secciones.every((s: { faltantes: unknown[] }) => s.faltantes.length === 0),
      ).toBe(true);
    });

    it('sin cuidador, el avance no exige sus datos (RF-CAR-02)', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      const sinCuidador = Object.fromEntries(
        Object.entries(completo(c)).filter(([k]) => !k.startsWith('cuidador')),
      );
      const r = await guardar(p.token, { version: 0, ...sinCuidador, requiereCuidador: false });
      expect(r.body.avance).toMatchObject({ porcentaje: 100, completa: true });
    });

    it('la regla vive en el dominio y no cuenta los datos que ya vienen de la preinscripción', () => {
      const a = calcularAvance(datosVacios());
      expect(a.requeridos).toBe(2 + 1 + 3 + 1);
      expect(a.completados).toBe(0);
      expect(normalizarTelefono('+57 (300) 123-4567')).toBe('3001234567');
    });
  });

  describe('nombres y correcciones (RNF-10)', () => {
    it('corregir el nombre conserva el valor anterior, el nuevo, quién y cuándo', async () => {
      const p = await persona();
      const r = await guardar(p.token, {
        version: 0,
        pcdNombre: '  María   Fernanda Pérez Gómez ',
      });
      expect(r.status).toBe(200);
      expect(r.body.pcdNombre).toBe('María Fernanda Pérez Gómez');
      expect((await ver(p.token)).body.pcd.nombre).toBe('María Fernanda Pérez Gómez');
      const h = await e.servicios.caracterizacion.correcciones(p.solicitudId);
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({
        entidad: 'persona',
        campo: 'nombre_completo',
        valorAnterior: 'María Fernanda Pérez',
        valorNuevo: 'María Fernanda Pérez Gómez',
        origen: 'CIUDADANO',
        usuarioId: null,
      });
      expect(h[0]!.creadoAt).toBeInstanceOf(Date);
    });

    it('el historial no se puede modificar ni borrar', async () => {
      const p = await persona();
      await guardar(p.token, { version: 0, pcdNombre: 'María Fernanda Pérez Gómez' });
      await expect(
        e.pool.query(`UPDATE historial_correcciones SET valor_nuevo = 'x'`),
      ).rejects.toThrow(/inmutable/);
      await expect(e.pool.query(`DELETE FROM historial_correcciones`)).rejects.toThrow(/inmutable/);
    });

    it('el nombre del cuidador se puede corregir mientras no esté en otra solicitud', async () => {
      const p = await persona();
      const r = await guardar(p.token, { version: 0, cuidadorNombre: 'Carlos Alberto López' });
      expect(r.status).toBe(200);
      expect((await ver(p.token)).body.cuidador.nombre).toBe('Carlos Alberto López');
    });

    it('el nombre de un cuidador compartido no se cambia desde el formulario de otra persona', async () => {
      const compartido = '8800123';
      const a = await persona({ cuidadorNumero: compartido });
      const b = await persona({ cuidadorNumero: compartido });
      const vista = (await ver(b.token)).body;
      expect(vista.cuidador.nombreEditable).toBe(false);
      const r = await guardar(b.token, { version: 0, cuidadorNombre: 'Otro Nombre Distinto' });
      expect(r.status).toBe(422);
      expect(r.body.error.errores[0].campo).toBe('cuidadorNombre');
      expect((await ver(a.token)).body.cuidador.nombre).toBe('Carlos López');
    });

    it('guardar un nombre igual no genera historial', async () => {
      const p = await persona();
      await guardar(p.token, { version: 0, pcdNombre: 'María Fernanda Pérez' });
      expect(await e.servicios.caracterizacion.correcciones(p.solicitudId)).toHaveLength(0);
    });

    it('los valores sensibles del historial se guardan cifrados y se leen descifrados', async () => {
      const p = await persona();
      const cipher = new DataCipher(e.deps.env.encryption);
      await e.pool.query(`INSERT INTO caracterizaciones (solicitud_id) VALUES ($1)`, [
        p.solicitudId,
      ]);
      await correccionesRepo.registrar(
        e.pool,
        {
          solicitudId: p.solicitudId,
          entidad: 'caracterizacion',
          entidadId: p.solicitudId,
          cambios: [
            { campo: 'subsidioCual', anterior: 'Colombia Mayor', nuevo: 'Renta Ciudadana' },
          ],
          usuarioId: null,
          ip: null,
        },
        cipher,
      );
      const crudo = (
        await e.pool.query(
          `SELECT valor_anterior, valor_nuevo, sensible FROM historial_correcciones WHERE campo = 'subsidioCual'`,
        )
      ).rows[0];
      expect(crudo.sensible).toBe(true);
      expect(crudo.valor_anterior).not.toContain('Colombia');
      expect(crudo.valor_nuevo).not.toContain('Renta');
      const h = await correccionesRepo.porSolicitud(e.pool, p.solicitudId, cipher);
      expect(h[0]).toMatchObject({
        valorAnterior: 'Colombia Mayor',
        valorNuevo: 'Renta Ciudadana',
      });
    });
  });

  describe('cuidador de varias PCD (RF-CAR-02, RN-01)', () => {
    it('se permite y las dos solicitudes quedan marcadas', async () => {
      const compartido = '8800456';
      const a = await persona({ cuidadorNumero: compartido });
      const solo = await persona();
      expect(await e.servicios.caracterizacion.otrasSolicitudesDelCuidador(a.solicitudId)).toBe(0);
      const b = await persona({ cuidadorNumero: compartido });
      expect(await e.servicios.caracterizacion.otrasSolicitudesDelCuidador(a.solicitudId)).toBe(1);
      expect(await e.servicios.caracterizacion.otrasSolicitudesDelCuidador(b.solicitudId)).toBe(1);
      expect(await e.servicios.caracterizacion.otrasSolicitudesDelCuidador(solo.solicitudId)).toBe(
        0,
      );
      const personas = await e.pool.query(
        `SELECT count(*)::int AS n FROM personas WHERE numero_identificacion = $1`,
        [compartido],
      );
      expect(personas.rows[0].n).toBe(1);
    });

    it('el formulario del ciudadano no revela que el cuidador figura en otra solicitud', async () => {
      const compartido = '8800789';
      await persona({ cuidadorNumero: compartido });
      const b = await persona({ cuidadorNumero: compartido });
      const texto = JSON.stringify((await ver(b.token)).body);
      expect(texto).not.toMatch(/otras?_?solicitudes|compartid/i);
    });
  });

  describe('datos sensibles cifrados en reposo (RNF-03)', () => {
    it('etnia, EPS, embarazo y subsidios no quedan en claro en la base de datos', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      await guardar(p.token, {
        version: 0,
        generoId: idDe(c.generos, 'FEMENINO'),
        etniaId: idDe(c.etnias, 'RAIZAL'),
        epsId: idDe(c.eps, 'SANITAS'),
        embarazo: 'SI',
        semanasGestacion: 12,
        recibeSubsidios: true,
        subsidioCual: 'Colombia Mayor',
        ocupacionId: idDe(c.ocupaciones, 'ESTUDIANTE'),
      });
      const fila = (
        await e.pool.query(`SELECT * FROM caracterizaciones WHERE solicitud_id = $1`, [
          p.solicitudId,
        ])
      ).rows[0];
      expect(fila.datos_sensibles).toBeInstanceOf(Buffer);
      expect(fila.datos_sensibles.toString('utf8')).not.toContain('Colombia Mayor');
      expect(fila.datos_sensibles.toString('utf8')).not.toContain('SANITAS');
      expect(JSON.stringify(fila)).not.toContain('Colombia Mayor');
      // Los datos que no son sensibles quedan en columnas normales.
      expect(fila.pcd_ocupacion_id).toBe(idDe(c.ocupaciones, 'ESTUDIANTE'));
      // Y al leer se descifran.
      const leido = (await ver(p.token)).body.datos;
      expect(leido).toMatchObject({
        etniaId: idDe(c.etnias, 'RAIZAL'),
        epsId: idDe(c.eps, 'SANITAS'),
        embarazo: 'SI',
        semanasGestacion: 12,
        recibeSubsidios: true,
        subsidioCual: 'Colombia Mayor',
      });
    });

    it('un sobre alterado no se acepta (el cifrado autentica el contenido)', async () => {
      const p = await persona();
      const c = (await ver(p.token)).body.catalogos as Respuesta['catalogos'];
      await guardar(p.token, { version: 0, epsId: idDe(c.eps, 'SANITAS') });
      await e.pool.query(
        `UPDATE caracterizaciones SET datos_sensibles = set_byte(datos_sensibles, length(datos_sensibles) - 1,
           (get_byte(datos_sensibles, length(datos_sensibles) - 1) + 1) % 256) WHERE solicitud_id = $1`,
        [p.solicitudId],
      );
      expect((await ver(p.token)).status).toBe(500);
    });
  });

  describe('integridad en la base de datos', () => {
    it('no admite datos del cuidador si no requiere el servicio, ni hijos sin tener hijos', async () => {
      const p = await persona();
      await expect(
        e.pool.query(
          `INSERT INTO caracterizaciones (solicitud_id, requiere_cuidador, cuidador_celular) VALUES ($1, false, '3001112222')`,
          [p.solicitudId],
        ),
      ).rejects.toThrow(/cuidador_solo_si_se_requiere/);
      await expect(
        e.pool.query(
          `INSERT INTO caracterizaciones (solicitud_id, tiene_hijos, hijos_cantidad, hijos_edades) VALUES ($1, false, 2, '{1,2}')`,
          [p.solicitudId],
        ),
      ).rejects.toThrow(/hijos_coherentes/);
      await expect(
        e.pool.query(
          `INSERT INTO caracterizaciones (solicitud_id, tiene_hijos, hijos_cantidad, hijos_edades) VALUES ($1, true, 2, '{1}')`,
          [p.solicitudId],
        ),
      ).rejects.toThrow(/hijos_edades_segun_cantidad/);
    });

    it('hay una sola caracterización por solicitud', async () => {
      const p = await persona();
      await guardar(p.token, { version: 0, celular: '3001112222' });
      await expect(
        e.pool.query(`INSERT INTO caracterizaciones (solicitud_id) VALUES ($1)`, [p.solicitudId]),
      ).rejects.toThrow(/caracterizaciones_pkey/);
    });
  });
});
