import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { casosSaltados, planificarAsignacion } from '../src/domain/asignacion.js';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';
import { ayudantesSolicitud, bearer, pdf } from './solicitudes.js';

const adm = '/api/v1/admin';
const pub = '/api/v1/publico';

describe('planificación de la asignación', () => {
  const caso = (
    solicitudId: number,
    extra: Partial<Parameters<typeof planificarAsignacion>[0][number]> = {},
  ) => ({
    solicitudId,
    personas: 1 as const,
    localidadId: null,
    transporteId: null,
    conBeneficio: false,
    ...extra,
  });
  const base = {
    cuposDisponibles: 2,
    presupuestoDisponible: 10_000,
    valorEstimulo: 1_000,
    cuposLocalidad: new Map<number, number>(),
    cuposTransporte: new Map<number, number>(),
  };

  it('alcanzan los primeros según los cupos y el resto queda sin cupo', () => {
    const r = planificarAsignacion([caso(1), caso(2), caso(3)], base);
    expect(r.map((x) => [x.alcanza, x.motivo])).toEqual([
      [true, null],
      [true, null],
      [false, 'SIN_CUPO'],
    ]);
  });

  it('el cuidador cuenta como una persona más en el presupuesto y un caso que no cabe no consume nada', () => {
    const r = planificarAsignacion([caso(1, { personas: 2 }), caso(2, { personas: 2 }), caso(3)], {
      ...base,
      cuposDisponibles: 5,
      presupuestoDisponible: 3_500,
    });
    expect(r.map((x) => x.motivo)).toEqual([null, 'SIN_PRESUPUESTO', null]);
  });

  it('respeta los topes por localidad y por tipo de transporte, y salta al siguiente caso', () => {
    const r = planificarAsignacion(
      [
        caso(1, { localidadId: 7 }),
        caso(2, { localidadId: 7 }),
        caso(3, { localidadId: 8, transporteId: 4 }),
        caso(4, { transporteId: 4 }),
      ],
      {
        ...base,
        cuposDisponibles: 10,
        cuposLocalidad: new Map([[7, 1]]),
        cuposTransporte: new Map([[4, 1]]),
      },
    );
    expect(r.map((x) => x.motivo)).toEqual([
      null,
      'SIN_CUPO_LOCALIDAD',
      null,
      'SIN_CUPO_TRANSPORTE',
    ]);
  });

  it('quien ya tiene un beneficio no se asigna (RN-01) y no gasta cupo', () => {
    const r = planificarAsignacion([caso(1, { conBeneficio: true }), caso(2)], {
      ...base,
      cuposDisponibles: 1,
    });
    expect(r.map((x) => x.motivo)).toEqual(['PERSONA_CON_BENEFICIO', null]);
  });

  it('los casos saltados son los que van antes del último elegido, no se eligen y podían asignarse', () => {
    const orden = [
      { solicitudId: 1, asignable: true },
      { solicitudId: 2, asignable: false },
      { solicitudId: 3, asignable: true },
      { solicitudId: 4, asignable: true },
      { solicitudId: 5, asignable: true },
    ];
    expect(casosSaltados(orden, new Set([4]))).toEqual([1, 3]);
    expect(casosSaltados(orden, new Set([1, 3, 4]))).toEqual([]);
    expect(casosSaltados(orden, new Set([1]))).toEqual([]);
    expect(casosSaltados(orden, new Set())).toEqual([]);
  });
});

describe('cupos, asignación y lista de espera (RF-ASI-01..04)', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let admin: CuentaPrueba;
  let validador: CuentaPrueba;
  let asignador: CuentaPrueba;
  let responsable: CuentaPrueba;
  let analista: CuentaPrueba;
  let control: CuentaPrueba;

  type Caso = Awaited<ReturnType<typeof ay.validada>>;
  let casoA: Caso;
  let casoB: Caso;
  let casoC: Caso;
  let casoD: Caso;
  let casoE: Caso;

  /** Todas las variables de priorización en «No», salvo las indicadas. */
  const valores = (dep: string, extra: Record<string, string> = {}) => ({
    DEPENDENCIA_FUNCIONAL: dep,
    ENFERMEDAD_CRONICA: 'NO',
    POBREZA_DESPLAZAMIENTO: 'NO',
    HOGAR_VULNERABLE: 'NO',
    EDAD_EXTREMA_MULTIPLE: 'NO',
    ...extra,
  });

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    asignador = await crearCuenta(e, 'ASIGNADOR');
    responsable = await crearCuenta(e, 'RESPONSABLE_PROCESO');
    analista = await crearCuenta(e, 'ANALISTA');
    control = await crearCuenta(e, 'CONTROL_INTERNO');
    // 70, 30, 20, 10 y 10 puntos (todas con cuidador).
    casoA = await ay.validada(
      validador,
      valores('SEVERA', {
        ENFERMEDAD_CRONICA: 'SI',
        POBREZA_DESPLAZAMIENTO: 'SI',
        HOGAR_VULNERABLE: 'SI',
        EDAD_EXTREMA_MULTIPLE: 'SI',
      }),
      { correo: 'caso.a@correo.com' },
    );
    casoB = await ay.validada(validador, valores('SEVERA'), {
      correo: 'caso.b@correo.com',
    });
    casoC = await ay.validada(validador, valores('MODERADA'), {
      correo: 'caso.c@correo.com',
    });
    casoD = await ay.validada(validador, valores('LEVE'), {
      correo: 'caso.d@correo.com',
    });
    casoE = await ay.validada(validador, valores('LEVE'), {
      correo: 'caso.e@correo.com',
    });
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const get = (c: CuentaPrueba, ruta: string) =>
    request(e.app).get(`${adm}/asignacion${ruta}`).set(auth(c));
  const post = (c: CuentaPrueba, ruta: string, cuerpo: object = {}) =>
    request(e.app).post(`${adm}/asignacion${ruta}`).set(auth(c)).send(cuerpo);
  const ajustar = (c: CuentaPrueba, datos: object, conSoporte = true) => {
    const r = request(e.app)
      .put(`${adm}/asignacion/cupos`)
      .set(auth(c))
      .field('datos', JSON.stringify(datos));
    return conSoporte ? r.attach('archivo', pdf('acto'), 'acto-de-adicion.pdf') : r;
  };
  const propuesta = async (c: CuentaPrueba = asignador) => (await get(c, '/propuesta')).body;
  const filaDe = async (caso: Caso) =>
    (await propuesta()).items.find((x: { radicado: string }) => x.radicado === caso.radicado);
  const estadoDe = async (caso: Caso) =>
    (
      await e.pool.query<{ estado: string }>(`SELECT estado FROM solicitudes WHERE id = $1`, [
        caso.solicitudId,
      ])
    ).rows[0]!.estado;
  const beneficioDe = async (caso: Caso) =>
    (
      await e.pool.query<{ id: string }>(`SELECT id FROM beneficios WHERE solicitud_id = $1`, [
        caso.solicitudId,
      ])
    ).rows[0]!.id;
  const ultimoCorreo = async () => {
    await e.servicios.correos.esperarDespachos();
    return e.mailer.ultimo();
  };

  describe('permisos por rol (RF-SEG-02)', () => {
    it('cada rol hace solo lo suyo, también por la API', async () => {
      expect((await request(e.app).get(`${adm}/asignacion/cupos`)).status).toBe(401);
      expect((await get(validador, '/cupos')).status).toBe(403);
      expect((await get(validador, '/propuesta')).status).toBe(403);
      for (const c of [analista, control, asignador, responsable, admin]) {
        expect((await get(c, '/propuesta')).status).toBe(200);
        expect((await get(c, '/cupos')).status).toBe(200);
      }
      // Solo el responsable del proceso y el administrador configuran los cupos.
      expect(
        (await ajustar(asignador, { cuposTotales: 5, motivo: 'Cambio de prueba' })).status,
      ).toBe(403);
      expect(
        (await ajustar(analista, { cuposTotales: 5, motivo: 'Cambio de prueba' })).status,
      ).toBe(403);
      // Solo el asignador y el administrador asignan.
      expect(
        (await post(responsable, '/asignar', { solicitudIds: [casoA.solicitudId] })).status,
      ).toBe(403);
      expect((await post(analista, '/asignar', { solicitudIds: [casoA.solicitudId] })).status).toBe(
        403,
      );
      expect(
        (await post(validador, '/asignar', { solicitudIds: [casoA.solicitudId] })).status,
      ).toBe(403);
      expect((await post(responsable, '/lista-espera')).status).toBe(403);
      expect((await get(validador, '/beneficiarios')).status).toBe(403);
    });
  });

  describe('cupos, valor del estímulo y presupuesto (RF-ASI-01)', () => {
    it('sin cupos configurados ningún caso alcanza', async () => {
      const f = (await get(asignador, '/cupos')).body;
      expect(f.cupos).toMatchObject({ totales: 0, ocupados: 0, disponibles: 0 });
      expect(f.catalogos.localidades.length).toBeGreaterThan(0);
      expect(f.catalogos.tiposTransporte.length).toBeGreaterThan(0);
      const p = await propuesta();
      expect(p).toMatchObject({ total: 5, alcanzan: 0 });
      expect(p.items[0]).toMatchObject({
        radicado: casoA.radicado,
        alcanza: false,
        motivo: 'SIN_CUPO',
      });
    });

    it('cambiar los cupos o el presupuesto exige motivo y soporte, y todo queda registrado', async () => {
      const sinSoporte = await ajustar(
        responsable,
        { cuposTotales: 3, motivo: 'Cupos de la vigencia' },
        false,
      );
      expect(sinSoporte.status).toBe(422);
      expect(sinSoporte.body.error.errores.map((x: { campo: string }) => x.campo)).toContain(
        'archivo',
      );
      const sinMotivo = await ajustar(responsable, { cuposTotales: 3, motivo: 'corto' });
      expect(sinMotivo.status).toBe(422);
      expect(sinMotivo.body.error.errores[0].campo).toBe('motivo');
      expect((await ajustar(responsable, { motivo: 'No cambia nada del programa' })).status).toBe(
        422,
      );
      expect(
        (await ajustar(responsable, { cuposTotales: -1, motivo: 'Cupos negativos' })).status,
      ).toBe(422);
      const sinJson = await request(e.app).put(`${adm}/asignacion/cupos`).set(auth(responsable));
      expect(sinJson.status).toBe(422);

      const ok = await ajustar(responsable, {
        cuposTotales: 3,
        presupuestoTotal: 2_500_000,
        motivo: 'Resolución de la vigencia 2026',
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.cupos).toMatchObject({ totales: 3, disponibles: 3 });
      expect(ok.body.presupuesto).toMatchObject({
        total: 2_500_000,
        comprometido: 0,
        disponible: 2_500_000,
      });
      // El valor del estímulo no exige soporte, pero sí motivo.
      const valor = await ajustar(
        responsable,
        { valorEstimulo: 500_000, motivo: 'Valor definido por la Gerencia' },
        false,
      );
      expect(valor.status, JSON.stringify(valor.body)).toBe(200);
      expect(valor.body.valorEstimulo).toBe(500_000);
      // Si otra persona ya cambió el valor mientras se editaba, no se pisa su cambio.
      const desactualizado = await ajustar(
        responsable,
        {
          valorEstimulo: 600_000,
          base: { valorEstimulo: 400_000 },
          motivo: 'Cambio sobre un dato que ya no es el vigente',
        },
        false,
      );
      expect(desactualizado.status).toBe(409);
      expect(desactualizado.body.error.codigo).toBe('DATOS_CAMBIARON');
      expect(desactualizado.body.error.mensaje).toContain('el valor del estímulo');

      const historial = (await get(analista, '/cupos/ajustes')).body.items as {
        id: number;
        tipo: string;
        motivo: string;
        soporte: { nombre: string } | null;
        creadoPor: string;
        valorAnterior: unknown;
        valorNuevo: unknown;
      }[];
      expect(historial.map((h) => h.tipo).sort()).toEqual([
        'CUPOS',
        'PRESUPUESTO',
        'VALOR_ESTIMULO',
      ]);
      const cupos = historial.find((h) => h.tipo === 'CUPOS')!;
      expect(cupos).toMatchObject({
        valorAnterior: 0,
        valorNuevo: 3,
        creadoPor: responsable.usuario,
      });
      expect(cupos.soporte?.nombre).toBe('acto-de-adicion.pdf');
      const soporte = await get(analista, `/cupos/ajustes/${cupos.id}/soporte`);
      expect(soporte.status).toBe(200);
      expect(Buffer.from(soporte.body).toString('latin1')).toContain('%PDF');
      const valorId = historial.find((h) => h.tipo === 'VALOR_ESTIMULO')!.id;
      expect((await get(analista, `/cupos/ajustes/${valorId}/soporte`)).status).toBe(404);
      // El historial es inmutable.
      await expect(
        e.pool.query(`UPDATE cupos_ajustes SET motivo = 'otro motivo distinto'`),
      ).rejects.toBeDefined();
      await expect(e.pool.query(`DELETE FROM cupos_ajustes`)).rejects.toBeDefined();
      const bit = await e.pool.query(`SELECT 1 FROM bitacora WHERE accion = 'CUPOS_AJUSTADOS'`);
      expect(bit.rowCount).toBe(3);
    });

    it('la distribución por localidad y transporte no puede pasar de los cupos ni usar elementos ajenos', async () => {
      const filtros = (await request(e.app).get(`${adm}/priorizacion/filtros`).set(auth(asignador)))
        .body as {
        localidades: { id: number }[];
        tiposTransporte: { id: number }[];
      };
      const [l1, l2] = filtros.localidades;
      const t1 = filtros.tiposTransporte[0]!;
      const demasiados = await ajustar(
        responsable,
        {
          distribucionLocalidad: [
            { itemId: l1!.id, cupos: 2 },
            { itemId: l2!.id, cupos: 2 },
          ],
          motivo: 'Distribución por localidad',
        },
        false,
      );
      expect(demasiados.status).toBe(422);
      expect(demasiados.body.error.errores[0].campo).toBe('distribucionLocalidad');
      const ajeno = await ajustar(
        responsable,
        {
          distribucionLocalidad: [{ itemId: t1.id, cupos: 1 }],
          motivo: 'Distribución por localidad',
        },
        false,
      );
      expect(ajeno.status).toBe(422);
      const ok = await ajustar(
        responsable,
        {
          distribucionLocalidad: [
            { itemId: l1!.id, cupos: 2 },
            { itemId: l2!.id, cupos: 1 },
          ],
          distribucionTransporte: [{ itemId: t1.id, cupos: 3 }],
          motivo: 'Distribución acordada con la Gerencia',
        },
        false,
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.distribucion.localidades).toHaveLength(2);
      expect(ok.body.distribucion.transportes[0]).toMatchObject({
        itemId: t1.id,
        cupos: 3,
        ocupados: 0,
      });
      // Ahora los cupos no pueden quedar por debajo de lo distribuido.
      const baja = await ajustar(responsable, { cuposTotales: 2, motivo: 'Reducir los cupos' });
      expect(baja.status).toBe(422);
      expect(baja.body.error.errores[0].mensaje).toContain('distribución');
      // Se vuelve a dejar sin distribución para el resto del recorrido.
      const quitar = await ajustar(
        responsable,
        {
          distribucionLocalidad: [],
          distribucionTransporte: [],
          motivo: 'Sin distribución por ahora',
        },
        false,
      );
      expect(quitar.body.distribucion.localidades).toEqual([]);
    });
  });

  describe('propuesta y asignación en orden de prioridad (RF-ASI-02, RF-ASI-04)', () => {
    it('propone en orden de puntaje lo que alcanza según los cupos y el presupuesto', async () => {
      const p = await propuesta();
      expect(p.items.map((x: { radicado: string }) => x.radicado)).toEqual([
        casoA.radicado,
        casoB.radicado,
        casoC.radicado,
        casoD.radicado,
        casoE.radicado,
      ]);
      // Con cuidador cada caso compromete 2 × 500.000: caben dos con 2.500.000.
      expect(p).toMatchObject({ total: 5, alcanzan: 2, sinCupo: 3 });
      expect(p.items.map((x: { alcanza: boolean }) => x.alcanza)).toEqual([
        true,
        true,
        false,
        false,
        false,
      ]);
      expect(p.items[2]).toMatchObject({
        motivo: 'SIN_PRESUPUESTO',
        motivoTexto: 'No alcanza el presupuesto disponible',
      });
      expect(p.items[0]).toMatchObject({ puntajeFinal: 70, posicion: 1 });
    });

    it('saltarse un caso que va antes en el orden exige registrar la causa', async () => {
      const sin = await post(asignador, '/asignar', { solicitudIds: [casoB.solicitudId] });
      expect(sin.status).toBe(422);
      expect(sin.body.error.errores[0].campo).toBe('omisiones');
      expect(sin.body.error.errores[0].mensaje).toContain(casoA.radicado);
      const corta = await post(asignador, '/asignar', {
        solicitudIds: [casoB.solicitudId],
        omisiones: [{ solicitudId: casoA.solicitudId, causa: 'no' }],
      });
      expect(corta.status).toBe(422);
      expect(await estadoDe(casoB)).toBe('PRIORIZADA');

      const causa = 'La familia pidió aplazar la entrega por tratamiento médico';
      const ok = await post(asignador, '/asignar', {
        solicitudIds: [casoB.solicitudId],
        omisiones: [{ solicitudId: casoA.solicitudId, causa }],
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body.asignados).toBe(1);
      expect(await estadoDe(casoB)).toBe('ASIGNADA');
      expect(await estadoDe(casoA)).toBe('PRIORIZADA');
      const om = await e.pool.query(
        `SELECT causa, posicion, puntaje_final FROM asignacion_omisiones WHERE solicitud_id = $1`,
        [casoA.solicitudId],
      );
      expect(om.rows).toEqual([{ causa, posicion: 1, puntaje_final: '70.00' }]);
      const bit = await e.pool.query(
        `SELECT usuario_id, justificacion FROM bitacora WHERE accion = 'ASIGNACION_OMITIDA' AND solicitud_id = $1`,
        [casoA.solicitudId],
      );
      expect(bit.rows[0]).toMatchObject({ usuario_id: asignador.id, justificacion: causa });
      // El beneficio queda pendiente de entrega, con su cupo y el valor de las dos personas comprometidos.
      const ben = (await get(analista, '/beneficiarios')).body.items[0];
      expect(ben).toMatchObject({
        radicado: casoB.radicado,
        estado: 'PENDIENTE_ENTREGA',
        personas: 2,
        valorComprometido: 1_000_000,
        posicion: 2,
        puntajeFinal: 30,
        asignadoPor: asignador.usuario,
        reemplazaRadicado: null,
      });
      const f = (await get(asignador, '/cupos')).body;
      expect(f.cupos).toMatchObject({ ocupados: 1, disponibles: 2 });
      expect(f.presupuesto).toMatchObject({ comprometido: 1_000_000, disponible: 1_500_000 });
    });

    it('al asignar se notifica por correo con las instrucciones de la entrega y el caso lo ve en su consulta', async () => {
      const correo = await ultimoCorreo();
      expect(correo.to).toBe('caso.b@correo.com');
      expect(correo.subject).toContain(casoB.radicado);
      expect(correo.text).toContain('resultó beneficiaria');
      expect(correo.text).toContain('lugar, la fecha y el horario');
      expect(correo.text).toContain('Documento de identidad original');
      expect(correo.text).toMatch(/consulta\?token=/);
      const estado = await request(e.app).get(`${pub}/consulta/solicitud`).set(bearer(casoB.token));
      expect(estado.status).toBe(200);
      expect(estado.body.estado).toMatchObject({ codigo: 'ASIGNADA', nombre: 'Asignada' });
    });

    it('no asigna lo que no cabe en el presupuesto ni casos que ya no están disponibles', async () => {
      const sinSaldo = await post(asignador, '/asignar', {
        solicitudIds: [casoC.solicitudId, casoA.solicitudId],
      });
      expect(sinSaldo.status, JSON.stringify(sinSaldo.body)).toBe(409);
      expect(
        sinSaldo.body.error.detalle.detalle?.casos ?? sinSaldo.body.error.detalle?.casos,
      ).toBeDefined();
      expect(await estadoDe(casoC)).toBe('PRIORIZADA');
      expect(await estadoDe(casoA)).toBe('PRIORIZADA');
      const ajeno = await post(asignador, '/asignar', { solicitudIds: [casoB.solicitudId] });
      expect(ajeno.status).toBe(409);
      expect(ajeno.body.error.codigo).toBe('CASO_NO_ASIGNABLE');
      expect((await post(asignador, '/asignar', { solicitudIds: [] })).status).toBe(422);
    });

    it('asigna el caso que se había saltado, sin pedir causa, y todo queda en la bitácora', async () => {
      const r = await post(asignador, '/asignar', { solicitudIds: [casoA.solicitudId] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.resumen.cupos).toMatchObject({ ocupados: 2, disponibles: 1 });
      expect(r.body.resumen.presupuesto).toMatchObject({
        comprometido: 2_000_000,
        disponible: 500_000,
      });
      const bit = await e.pool.query(
        `SELECT usuario_id FROM bitacora WHERE accion = 'BENEFICIO_ASIGNADO' ORDER BY id`,
      );
      expect(bit.rows.map((x) => x.usuario_id)).toEqual([asignador.id, asignador.id]);
      // Los casos asignados ya no están en la propuesta.
      const p = await propuesta();
      expect(p.items.map((x: { radicado: string }) => x.radicado)).toEqual([
        casoC.radicado,
        casoD.radicado,
        casoE.radicado,
      ]);
      expect(p.alcanzan).toBe(0);
    });

    it('RN-01: una persona no puede tener más de un beneficio vigente', async () => {
      // El cuidador del caso E es la persona con discapacidad del caso A, que ya es beneficiaria.
      await e.pool.query(
        `UPDATE solicitudes SET cuidador_id = (SELECT pcd_id FROM solicitudes WHERE id = $1) WHERE id = $2`,
        [casoA.solicitudId, casoE.solicitudId],
      );
      const fila = await filaDe(casoE);
      expect(fila).toMatchObject({ alcanza: false, motivo: 'PERSONA_CON_BENEFICIO' });
      // También lo impide la base de datos.
      await expect(
        e.pool.query(
          `INSERT INTO beneficio_personas (beneficio_id, persona_id, rol)
           SELECT b.id, s.pcd_id, 'CUIDADOR' FROM beneficios b, solicitudes s
            WHERE b.solicitud_id = $1 AND s.id = $1`,
          [casoB.solicitudId],
        ),
      ).rejects.toBeDefined();
    });
  });

  describe('lista de espera (RF-ASI-03, RF-ASI-04)', () => {
    it('los casos que no alcanzan pasan a lista de espera y se les avisa; quien tiene beneficio no', async () => {
      const r = await post(asignador, '/lista-espera');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.radicados.sort()).toEqual([casoC.radicado, casoD.radicado].sort());
      expect(await estadoDe(casoC)).toBe('EN_LISTA_ESPERA');
      expect(await estadoDe(casoD)).toBe('EN_LISTA_ESPERA');
      // El caso bloqueado por RN-01 no se manda a la lista de espera.
      expect(await estadoDe(casoE)).toBe('PRIORIZADA');
      await e.servicios.correos.esperarDespachos();
      const correos = e.mailer.enviados.filter((m) => m.subject.includes('lista de espera'));
      expect(correos.map((m) => m.to).sort()).toEqual(['caso.c@correo.com', 'caso.d@correo.com']);
      expect(correos[0]!.text).toContain('lista de espera, ordenado según su puntaje');
      // La persona lo ve en la consulta de su caso.
      const estado = await request(e.app).get(`${pub}/consulta/solicitud`).set(bearer(casoC.token));
      expect(estado.body.estado).toMatchObject({ codigo: 'EN_LISTA_ESPERA' });
      // Conservan su lugar por puntaje en la propuesta.
      const p = await propuesta();
      expect(
        p.items.map((x: { radicado: string; estado: string }) => [x.radicado, x.estado]),
      ).toEqual([
        [casoC.radicado, 'EN_LISTA_ESPERA'],
        [casoD.radicado, 'EN_LISTA_ESPERA'],
        [casoE.radicado, 'PRIORIZADA'],
      ]);
      // Repetir no vuelve a avisar.
      expect((await post(asignador, '/lista-espera')).body.enListaDeEspera).toBe(0);
    });

    it('al liberarse un cupo se avisa al asignador y se propone el siguiente caso de la lista', async () => {
      const beneficioB = Number(await beneficioDe(casoB));
      await e.servicios.asignacion.liberarCupo(
        e.pool,
        asignador.id,
        beneficioB,
        'Renuncia voluntaria de la familia',
        { ip: null },
      );
      const f = (await get(asignador, '/cupos')).body;
      expect(f.cupos).toMatchObject({ ocupados: 1, liberados: 1, disponibles: 2 });
      expect(f.presupuesto).toMatchObject({ comprometido: 1_000_000, disponible: 1_500_000 });
      const libre = await e.pool.query(
        `SELECT vigente FROM beneficio_personas WHERE beneficio_id = $1`,
        [beneficioB],
      );
      expect(libre.rows.every((x) => x.vigente === false)).toBe(true);
      // El aviso le llega al asignador y a nadie más.
      const avisos = (await request(e.app).get(`${adm}/alertas`).set(auth(asignador))).body
        .items as {
        id: number;
        tipo: string;
        mensaje: string;
        enlace: string;
      }[];
      // (También le llegaron los avisos de cada caso que quedó listo para asignar.)
      const liberados = avisos.filter((x) => x.tipo === 'CUPO_LIBERADO');
      expect(liberados).toHaveLength(1);
      expect(liberados[0]).toMatchObject({ enlace: '/interno/asignacion' });
      expect(liberados[0]!.mensaje).toContain(casoC.radicado);
      expect(avisos.some((x) => x.tipo === 'CASO_PRIORIZADO')).toBe(true);
      expect((await request(e.app).get(`${adm}/alertas`).set(auth(analista))).body.items).toEqual(
        [],
      );
      expect((await request(e.app).get(`${adm}/alertas`).set(auth(validador))).body.items).toEqual(
        [],
      );
      expect(
        (
          await request(e.app)
            .post(`${adm}/alertas/${liberados[0]!.id}/atender`)
            .set(auth(analista))
        ).status,
      ).toBe(404);
      expect(
        (
          await request(e.app)
            .post(`${adm}/alertas/${liberados[0]!.id}/atender`)
            .set(auth(asignador))
        ).status,
      ).toBe(204);
      const despues = (await request(e.app).get(`${adm}/alertas`).set(auth(asignador))).body
        .items as { tipo: string }[];
      expect(despues.some((x) => x.tipo === 'CUPO_LIBERADO')).toBe(false);
      // Liberar dos veces no se puede.
      await expect(
        e.servicios.asignacion.liberarCupo(e.pool, asignador.id, beneficioB, 'otra vez', {
          ip: null,
        }),
      ).rejects.toMatchObject({ code: 'BENEFICIO_FINALIZADO' });
      // El caso C ahora alcanza: no puede quedar en lista de espera, se asigna.
      const p = await propuesta();
      expect(p.items[0]).toMatchObject({ radicado: casoC.radicado, alcanza: true });
      expect(p.items[1]).toMatchObject({
        radicado: casoD.radicado,
        alcanza: false,
        motivo: 'SIN_PRESUPUESTO',
      });
      const conCupo = await post(asignador, '/lista-espera', { solicitudIds: [casoC.solicitudId] });
      expect(conCupo.status).toBe(409);
      expect(conCupo.body.error.codigo).toBe('CASO_CON_CUPO');
    });

    it('la reasignación deja la trazabilidad del cupo liberado y del nuevo beneficiario', async () => {
      const r = await post(asignador, '/asignar', { solicitudIds: [casoC.solicitudId] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await estadoDe(casoC)).toBe('ASIGNADA');
      const lista = (await get(analista, '/beneficiarios')).body.items as {
        radicado: string;
        estado: string;
        reemplazaRadicado: string | null;
        motivoFin: string | null;
      }[];
      expect(lista.find((b) => b.radicado === casoC.radicado)).toMatchObject({
        estado: 'PENDIENTE_ENTREGA',
        reemplazaRadicado: casoB.radicado,
      });
      expect(lista.find((b) => b.radicado === casoB.radicado)).toMatchObject({
        estado: 'FINALIZADO',
        motivoFin: 'Renuncia voluntaria de la familia',
      });
      const fin = (await get(analista, '/beneficiarios?estado=FINALIZADO')).body;
      expect(fin.items.map((b: { radicado: string }) => b.radicado)).toEqual([casoB.radicado]);
      expect((await get(analista, `/beneficiarios?q=${casoA.radicado}`)).body.total).toBe(1);
      // Un cupo liberado se usa una sola vez.
      expect(
        (
          await e.pool.query(
            `SELECT COUNT(*)::int AS n FROM beneficios WHERE reemplaza_beneficio_id IS NOT NULL`,
          )
        ).rows[0].n,
      ).toBe(1);
    });

    it('los cupos y el presupuesto no pueden quedar por debajo de lo ocupado', async () => {
      const cupos = await ajustar(responsable, { cuposTotales: 1, motivo: 'Reducción de cupos' });
      expect(cupos.status).toBe(422);
      expect(cupos.body.error.errores[0].campo).toBe('cuposTotales');
      const dinero = await ajustar(responsable, {
        presupuestoTotal: 1_000_000,
        motivo: 'Reducción del presupuesto',
      });
      expect(dinero.status).toBe(422);
      expect(dinero.body.error.errores[0].campo).toBe('presupuestoTotal');
    });
  });
});
