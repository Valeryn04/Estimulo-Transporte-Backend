import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  calcularPuntaje,
  erroresDeMatriz,
  ordenarPorPrioridad,
  puntajeMaximo,
  type VariableMatriz,
} from '../src/domain/priorizacion.js';
import {
  asignarEnBd,
  auth,
  crearCuenta,
  crearEntorno,
  type CuentaPrueba,
  type Entorno,
} from './helpers.js';
import { ayudantesSolicitud, pdf } from './solicitudes.js';

const adm = '/api/v1/admin';

const VARIABLES: VariableMatriz[] = [
  {
    codigo: 'DEP',
    nombre: 'Dependencia',
    descripcion: '',
    origen: 'VALIDADOR',
    peso: 2,
    opciones: [
      { codigo: 'ALTA', etiqueta: 'Alta', puntos: 20 },
      { codigo: 'BAJA', etiqueta: 'Baja', puntos: 5 },
    ],
  },
  {
    codigo: 'SUB',
    nombre: 'Sin subsidios',
    descripcion: '',
    origen: 'SUBSIDIOS',
    peso: 1,
    opciones: [
      { codigo: 'SIN_SUBSIDIOS', etiqueta: 'No recibe', puntos: 10 },
      { codigo: 'CON_SUBSIDIOS', etiqueta: 'Recibe', puntos: 0 },
    ],
  },
];

describe('reglas de la priorización', () => {
  it('el puntaje es la suma de peso por puntos de la opción elegida, con el detalle de cada variable', () => {
    const r = calcularPuntaje(VARIABLES, { DEP: 'ALTA', SUB: 'SIN_SUBSIDIOS' });
    expect(r.puntaje).toBe(50);
    expect(r.detalle).toEqual([
      expect.objectContaining({ variable: 'DEP', valor: 'ALTA', puntos: 20, peso: 2, aporte: 40 }),
      expect.objectContaining({ variable: 'SUB', aporte: 10 }),
    ]);
    expect(puntajeMaximo(VARIABLES)).toBe(50);
  });

  it('las variables sin valor válido no suman y se informan', () => {
    const r = calcularPuntaje(VARIABLES, { DEP: 'NO_EXISTE' });
    expect(r.puntaje).toBe(0);
    expect(r.faltantes.map((f) => f.codigo)).toEqual(['DEP', 'SUB']);
  });

  it('ordena por puntaje y desempata con los criterios, dejando el criterio aplicado', () => {
    const f = (
      radicado: string,
      puntajeFinal: number,
      dep: number,
      dia: number,
    ): Parameters<typeof ordenarPorPrioridad>[0][number] => ({
      puntajeFinal,
      aportes: { DEP: dep },
      radicadaAt: new Date(2026, 9, dia),
      radicado,
    });
    const r = ordenarPorPrioridad(
      [
        f('C', 40, 10, 3),
        f('B', 40, 30, 5),
        f('A', 60, 0, 9),
        f('D', 40, 10, 1),
        f('E', 40, 10, 1),
      ],
      ['VARIABLE:DEP', 'FECHA_RADICACION'],
    );
    expect(r.map((x) => x.radicado)).toEqual(['A', 'B', 'D', 'E', 'C']);
    expect(r.map((x) => x.criterioDesempate)).toEqual([
      null,
      null,
      'VARIABLE:DEP',
      'RADICADO',
      'FECHA_RADICACION',
    ]);
  });

  it('revisa la matriz: variables, opciones, origen de subsidios y criterios de desempate', () => {
    const base = { notas: '', desempate: [], variables: VARIABLES };
    expect(erroresDeMatriz(base)).toEqual([]);
    expect(erroresDeMatriz({ ...base, variables: [] })).toHaveLength(1);
    const repetida = erroresDeMatriz({ ...base, variables: [VARIABLES[0]!, VARIABLES[0]!] });
    expect(JSON.stringify(repetida)).toContain('repetido');
    const pocas = erroresDeMatriz({
      ...base,
      variables: [{ ...VARIABLES[0]!, opciones: [VARIABLES[0]!.opciones[0]!] }],
    });
    expect(JSON.stringify(pocas)).toContain('al menos dos opciones');
    const subsidios = erroresDeMatriz({
      ...base,
      variables: [{ ...VARIABLES[1]!, opciones: [{ codigo: 'OTRA', etiqueta: 'x', puntos: 1 }] }],
    });
    expect(JSON.stringify(subsidios)).toContain('recibe');
    expect(erroresDeMatriz({ ...base, desempate: ['VARIABLE:NO_EXISTE'] })[0]?.campo).toBe(
      'desempate',
    );
    expect(
      erroresDeMatriz({ ...base, desempate: ['FECHA_RADICACION', 'FECHA_RADICACION'] }),
    ).toHaveLength(1);
    const ceros = erroresDeMatriz({
      ...base,
      variables: [
        { ...VARIABLES[0]!, opciones: VARIABLES[0]!.opciones.map((o) => ({ ...o, puntos: 0 })) },
      ],
    });
    expect(JSON.stringify(ceros)).toContain('mayor que cero');
  });
});

describe('priorización (RF-PRI-01..04)', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let admin: CuentaPrueba;
  let validador: CuentaPrueba;
  let asignador: CuentaPrueba;
  let responsable: CuentaPrueba;
  let analista: CuentaPrueba;
  let control: CuentaPrueba;

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    asignador = await crearCuenta(e, 'ASIGNADOR');
    responsable = await crearCuenta(e, 'RESPONSABLE_PROCESO');
    analista = await crearCuenta(e, 'ANALISTA');
    control = await crearCuenta(e, 'CONTROL_INTERNO');
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const val = (c: CuentaPrueba, ruta: string) =>
    request(e.app).get(`${adm}/validacion${ruta}`).set(auth(c));
  const valPost = (c: CuentaPrueba, ruta: string, cuerpo: object = {}) =>
    request(e.app).post(`${adm}/validacion${ruta}`).set(auth(c)).send(cuerpo);
  const valPut = (c: CuentaPrueba, ruta: string, cuerpo: object) =>
    request(e.app).put(`${adm}/validacion${ruta}`).set(auth(c)).send(cuerpo);
  const pri = (c: CuentaPrueba, ruta: string) =>
    request(e.app).get(`${adm}/priorizacion${ruta}`).set(auth(c));
  const priPost = (c: CuentaPrueba, ruta: string, cuerpo: object = {}) =>
    request(e.app).post(`${adm}/priorizacion${ruta}`).set(auth(c)).send(cuerpo);
  const mat = (c: CuentaPrueba, ruta = '') =>
    request(e.app).get(`${adm}/matriz${ruta}`).set(auth(c));
  const matPost = (c: CuentaPrueba, ruta: string, cuerpo: object = {}) =>
    request(e.app).post(`${adm}/matriz${ruta}`).set(auth(c)).send(cuerpo);

  type Valores = Record<string, string>;
  const PRIMERAS: Valores = {
    DEPENDENCIA_FUNCIONAL: 'SEVERA',
    GRUPO_SISBEN: 'GRUPO_A',
    ENFERMEDAD_CRONICA: 'NO',
    POBREZA_DESPLAZAMIENTO: 'NO',
    HOGAR_VULNERABLE: 'NO',
    EDAD_EXTREMA_MULTIPLE: 'NO',
  };

  /** Lleva una solicitud hasta quedar validada, con los datos de priorización indicados. */
  async function validada(valores: Valores = {}, nombre = 'María Fernanda Pérez') {
    const s = await ay.solicitudRadicada({ nombre });
    await asignarEnBd(e, s.solicitudId, validador.id);
    await valPost(validador, `/casos/${s.solicitudId}/tomar`);
    const caso = (await val(validador, `/casos/${s.solicitudId}`)).body;
    for (const item of caso.items) {
      await valPut(validador, `/casos/${s.solicitudId}/items/${item.id}`, {
        resultado: 'CUMPLE',
        fuente: 'Consulta realizada',
      });
    }
    for (const [codigo, valor] of Object.entries({ ...PRIMERAS, ...valores })) {
      const r = await valPut(validador, `/casos/${s.solicitudId}/variables/${codigo}`, { valor });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    const r = await valPost(validador, `/casos/${s.solicitudId}/decision`, { decision: 'APROBAR' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return s;
  }

  const estadoDe = async (id: number) =>
    (await e.pool.query<{ estado: string }>(`SELECT estado FROM solicitudes WHERE id = $1`, [id]))
      .rows[0]!.estado;

  let casoA: Awaited<ReturnType<typeof validada>>;
  let casoB: Awaited<ReturnType<typeof validada>>;
  let tieX: Awaited<ReturnType<typeof validada>>;
  let tieY: Awaited<ReturnType<typeof validada>>;
  let gemeloP: Awaited<ReturnType<typeof validada>>;
  let gemeloQ: Awaited<ReturnType<typeof validada>>;

  describe('datos que registra el validador y cálculo automático al validar (RF-PRI-01)', () => {
    it('el caso pide los datos de la matriz vigente y no se aprueba sin ellos', async () => {
      const s = await ay.solicitudRadicada();
      await asignarEnBd(e, s.solicitudId, validador.id);
      await valPost(validador, `/casos/${s.solicitudId}/tomar`);
      const caso = (await val(validador, `/casos/${s.solicitudId}`)).body;
      expect(caso.priorizacion.matrizVersion).toBe(1);
      expect(caso.priorizacion.variables.map((v: { codigo: string }) => v.codigo)).toEqual([
        'DEPENDENCIA_FUNCIONAL',
        'GRUPO_SISBEN',
        'ENFERMEDAD_CRONICA',
        'POBREZA_DESPLAZAMIENTO',
        'HOGAR_VULNERABLE',
        'EDAD_EXTREMA_MULTIPLE',
      ]);
      expect(caso.priorizacion.puntaje).toBeNull();
      for (const item of caso.items) {
        await valPut(validador, `/casos/${s.solicitudId}/items/${item.id}`, {
          resultado: 'CUMPLE',
          fuente: 'x',
        });
      }
      const sin = await valPost(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'APROBAR',
      });
      expect(sin.status).toBe(422);
      expect(JSON.stringify(sin.body)).toContain('datos de priorización');
      expect(JSON.stringify(sin.body)).toContain('Dependencia funcional');
      // Valores inválidos o de otra variable no se aceptan.
      const malo = await valPut(validador, `/casos/${s.solicitudId}/variables/GRUPO_SISBEN`, {
        valor: 'SEVERA',
      });
      expect(malo.status).toBe(422);
      const noExiste = await valPut(validador, `/casos/${s.solicitudId}/variables/NO_EXISTE`, {
        valor: 'SI',
      });
      expect(noExiste.status).toBe(404);
      // La variable que sale de la caracterización no la registra el validador.
      const auto = await valPut(validador, `/casos/${s.solicitudId}/variables/AUSENCIA_SUBSIDIOS`, {
        valor: 'SIN_SUBSIDIOS',
      });
      expect(auto.status).toBe(404);
      // Solo quien tiene el caso en revisión y puede validar.
      expect(
        (
          await valPut(asignador, `/casos/${s.solicitudId}/variables/GRUPO_SISBEN`, {
            valor: 'GRUPO_A',
          })
        ).status,
      ).toBe(403);
    });

    it('al aprobar la validación se calcula solo el puntaje, con su detalle y la versión de la matriz', async () => {
      casoA = await validada({
        DEPENDENCIA_FUNCIONAL: 'SEVERA',
        GRUPO_SISBEN: 'GRUPO_A',
        ENFERMEDAD_CRONICA: 'SI',
        POBREZA_DESPLAZAMIENTO: 'SI',
        HOGAR_VULNERABLE: 'SI',
        EDAD_EXTREMA_MULTIPLE: 'SI',
      });
      expect(await estadoDe(casoA.solicitudId)).toBe('PRIORIZADA');
      const c = (await pri(asignador, `/casos/${casoA.solicitudId}`)).body;
      // 25 + 20 + 4 × 10 + 5 (no recibe otros subsidios)
      expect(c.puntaje).toBe(90);
      expect(c.puntajeFinal).toBe(90);
      expect(c.calculos).toHaveLength(1);
      expect(c.calculos[0]).toMatchObject({ matrizVersion: 1, vigente: true, calculadoPor: null });
      expect(c.calculos[0].detalle).toHaveLength(7);
      expect(c.calculos[0].detalle[0]).toMatchObject({
        variable: 'DEPENDENCIA_FUNCIONAL',
        etiqueta: 'Severa',
        puntos: 25,
        aporte: 25,
      });
      const b = await e.pool.query(
        `SELECT detalle FROM bitacora WHERE solicitud_id = $1 AND accion = 'VALIDACION_DECIDIDA'`,
        [casoA.solicitudId],
      );
      expect(b.rows[0].detalle).toMatchObject({ puntaje: 90 });
      // El cálculo guardado no se borra.
      await expect(e.pool.query(`DELETE FROM priorizaciones`)).rejects.toBeDefined();
    });

    it('los demás casos de prueba: baja prioridad, empates por dependencia y empate total', async () => {
      casoB = await validada({ DEPENDENCIA_FUNCIONAL: 'MODERADA', GRUPO_SISBEN: 'GRUPO_B' });
      tieX = await validada({ DEPENDENCIA_FUNCIONAL: 'MODERADA', GRUPO_SISBEN: 'GRUPO_A' });
      tieY = await validada({
        DEPENDENCIA_FUNCIONAL: 'LEVE',
        GRUPO_SISBEN: 'GRUPO_A',
        ENFERMEDAD_CRONICA: 'SI',
      });
      gemeloP = await validada({ DEPENDENCIA_FUNCIONAL: 'LEVE', GRUPO_SISBEN: 'GRUPO_C' });
      gemeloQ = await validada({ DEPENDENCIA_FUNCIONAL: 'LEVE', GRUPO_SISBEN: 'GRUPO_C' });
      const puntaje = async (id: number) => (await pri(asignador, `/casos/${id}`)).body.puntaje;
      expect(await puntaje(casoB.solicitudId)).toBe(35);
      expect(await puntaje(tieX.solicitudId)).toBe(40);
      expect(await puntaje(tieY.solicitudId)).toBe(40);
      expect(await puntaje(gemeloP.solicitudId)).toBe(18);
    });
  });

  describe('permisos por rol (RF-SEG-02)', () => {
    it('cada rol solo hace lo suyo, también por la API', async () => {
      expect((await pri(analista, '/listado')).status).toBe(200);
      expect((await pri(control, '/listado')).status).toBe(200);
      expect((await pri(validador, '/listado')).status).toBe(403);
      expect((await priPost(analista, '/calcular')).status).toBe(403);
      expect((await priPost(control, `/casos/${casoA.solicitudId}/calcular`)).status).toBe(403);
      expect((await mat(asignador)).status).toBe(403);
      expect((await mat(analista)).status).toBe(403);
      expect((await matPost(asignador, '')).status).toBe(403);
      expect((await matPost(responsable, '')).status).toBe(403);
      expect((await mat(responsable)).status).toBe(200);
      expect((await mat(admin)).status).toBe(200);
      expect((await request(e.app).get(`${adm}/priorizacion/listado`)).status).toBe(401);
    });
  });

  describe('listado priorizado y desempate (RF-PRI-04)', () => {
    it('ordena de mayor a menor puntaje y deja constancia del criterio de desempate', async () => {
      const r = await pri(asignador, '/listado');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const filas = r.body.items as {
        posicion: number;
        radicado: string;
        puntajeFinal: number;
        criterioDesempate: string | null;
      }[];
      expect(r.body.matrizVersion).toBe(1);
      expect(filas.map((f) => f.radicado)).toEqual([
        casoA.radicado, // 90
        tieX.radicado, // 40: mayor dependencia que tieY
        tieY.radicado, // 40
        casoB.radicado, // 35
        gemeloP.radicado, // 18: radicada antes que gemeloQ
        gemeloQ.radicado,
      ]);
      expect(filas.map((f) => f.posicion)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(filas[0]!.criterioDesempate).toBeNull();
      expect(filas[1]!.criterioDesempate).toBeNull();
      expect(filas[2]!.criterioDesempate).toBe('Mayor puntaje en «Dependencia funcional»');
      expect(filas[5]!.criterioDesempate).toBe('Fecha de radicación más antigua');
      expect(r.body.desempate).toEqual([
        'Mayor puntaje en «Dependencia funcional»',
        'Mayor puntaje en «Grupo del SISBÉN IV»',
        'Fecha de radicación más antigua',
      ]);
    });

    it('filtra por población, localidad, transporte y texto, y pagina', async () => {
      const sinCuidador = await pri(asignador, '/listado?poblacion=SIN_CUIDADOR');
      expect(sinCuidador.body.total).toBe(0);
      const conCuidador = await pri(asignador, '/listado?poblacion=CON_CUIDADOR');
      expect(conCuidador.body.total).toBe(6);
      const texto = await pri(asignador, `/listado?q=${casoB.radicado}`);
      expect(texto.body.items.map((f: { radicado: string }) => f.radicado)).toEqual([
        casoB.radicado,
      ]);
      const pag = await pri(asignador, '/listado?tamano=2&pagina=2');
      expect(pag.body.items.map((f: { posicion: number }) => f.posicion)).toEqual([3, 4]);
      expect(pag.body.total).toBe(6);
      // Solo el caso A queda en una localidad y con un tipo de transporte conocidos.
      await e.pool.query(
        `UPDATE solicitudes SET localidad_id = (SELECT id FROM catalogo_items WHERE catalogo = 'LOCALIDAD' ORDER BY id LIMIT 1)
          WHERE id = $1`,
        [casoA.solicitudId],
      );
      await e.pool.query(
        `UPDATE caracterizaciones SET tipo_transporte_id = (SELECT id FROM catalogo_items WHERE catalogo = 'TIPO_TRANSPORTE' ORDER BY id LIMIT 1)
          WHERE solicitud_id = $1`,
        [casoA.solicitudId],
      );
      const ids = await e.pool.query<{ localidad_id: number; tipo_transporte_id: number }>(
        `SELECT s.localidad_id, c.tipo_transporte_id FROM solicitudes s
           JOIN caracterizaciones c ON c.solicitud_id = s.id WHERE s.id = $1`,
        [casoA.solicitudId],
      );
      const porLocalidad = await pri(
        asignador,
        `/listado?localidadId=${ids.rows[0]!.localidad_id}`,
      );
      expect(porLocalidad.body.items.map((f: { radicado: string }) => f.radicado)).toEqual([
        casoA.radicado,
      ]);
      const porTransporte = await pri(
        asignador,
        `/listado?transporteId=${ids.rows[0]!.tipo_transporte_id}`,
      );
      expect(porTransporte.body.items.map((f: { radicado: string }) => f.radicado)).toEqual([
        casoA.radicado,
      ]);
      expect(porTransporte.body.items[0]).toMatchObject({
        transporte: expect.any(String),
        localidad: expect.any(String),
      });
      const rf = await pri(asignador, '/filtros');
      expect(rf.status, JSON.stringify(rf.body)).toBe(200);
      const filtros = rf.body;
      expect(filtros.localidades.length).toBeGreaterThan(0);
      expect(filtros.tiposTransporte.length).toBeGreaterThan(0);
      expect(filtros.localidades[0]).toMatchObject({
        id: expect.any(Number),
        nombre: expect.any(String),
      });
      const ninguna = await pri(asignador, '/listado?localidadId=999999');
      expect(ninguna.body.total).toBe(0);
      expect((await pri(asignador, '/listado?pagina=0')).status).toBe(422);
    });
  });

  describe('excepciones justificadas (RF-PRI-03)', () => {
    let excepcionId: number;
    const proponer = (
      c: CuentaPrueba,
      id: number,
      campos: Record<string, string>,
      archivo = true,
    ) => {
      let r = request(e.app).post(`${adm}/priorizacion/casos/${id}/excepciones`).set(auth(c));
      for (const [k, v] of Object.entries(campos)) r = r.field(k, v);
      return archivo ? r.attach('archivo', pdf('soporte'), 'soporte.pdf') : r;
    };
    const JUSTIFICACION =
      'Persona en lista de espera de trasplante con controles semanales y sin red de apoyo.';

    it('exige justificación, evidencia y que quien propone tenga el permiso', async () => {
      const base = { ajuste: '20', justificacion: JUSTIFICACION };
      expect((await proponer(validador, casoB.solicitudId, base)).status).toBe(403);
      expect((await proponer(responsable, casoB.solicitudId, base)).status).toBe(403);
      const sinArchivo = await proponer(asignador, casoB.solicitudId, base, false);
      expect(sinArchivo.status).toBe(422);
      expect(sinArchivo.body.error.errores[0].campo).toBe('archivo');
      const corta = await proponer(asignador, casoB.solicitudId, {
        ajuste: '20',
        justificacion: 'Urgente',
      });
      expect(corta.status).toBe(422);
      expect(corta.body.error.errores[0].campo).toBe('justificacion');
      expect((await proponer(asignador, casoB.solicitudId, { ...base, ajuste: '0' })).status).toBe(
        422,
      );
      expect(
        (await proponer(asignador, casoB.solicitudId, { ...base, ajuste: '300' })).status,
      ).toBe(422);
      // El puntaje con el ajuste no puede ser negativo.
      expect(
        (await proponer(asignador, casoB.solicitudId, { ...base, ajuste: '-80' })).status,
      ).toBe(422);
      const noPdf = await request(e.app)
        .post(`${adm}/priorizacion/casos/${casoB.solicitudId}/excepciones`)
        .set(auth(asignador))
        .field('ajuste', '20')
        .field('justificacion', JUSTIFICACION)
        .attach('archivo', Buffer.from('texto plano'), 'nota.pdf');
      expect(noPdf.status).toBe(422);
    });

    it('se propone con evidencia: no cambia el puntaje hasta que la aprueba el responsable', async () => {
      const r = await proponer(asignador, casoB.solicitudId, {
        ajuste: '20',
        justificacion: JUSTIFICACION,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      excepcionId = r.body.id;
      expect(r.body).toMatchObject({
        estado: 'PROPUESTA',
        ajuste: 20,
        puntajeOriginal: 35,
        puntajeConAjuste: 55,
        propuestaPor: asignador.usuario,
      });
      expect(r.body.evidencia).toMatchObject({ nombre: 'soporte.pdf', mime: 'application/pdf' });
      // Sigue en su lugar y se marca la propuesta pendiente.
      const fila = (await pri(asignador, `/listado?q=${casoB.radicado}`)).body.items[0];
      expect(fila).toMatchObject({ puntajeFinal: 35, ajuste: 0, excepcionPendiente: true });
      // Solo una propuesta abierta por caso.
      const otra = await proponer(asignador, casoB.solicitudId, {
        ajuste: '5',
        justificacion: JUSTIFICACION,
      });
      expect(otra.status).toBe(409);
      expect(otra.body.error.codigo).toBe('EXCEPCION_ABIERTA');
      // La evidencia se descarga descifrada y queda en el expediente.
      const ev = await pri(analista, `/excepciones/${excepcionId}/evidencia`);
      expect(ev.status).toBe(200);
      expect(ev.headers['content-disposition']).toContain('attachment');
      expect(Buffer.from(ev.body).toString('latin1')).toContain('%PDF');
      const lista = await pri(analista, '/excepciones?estado=PROPUESTA');
      expect(lista.body.items.map((x: { id: number }) => x.id)).toEqual([excepcionId]);
    });

    it('la decide el responsable del proceso, nunca quien la propuso, y el rechazo exige motivo', async () => {
      const decidir = (c: CuentaPrueba, cuerpo: object) =>
        priPost(c, `/excepciones/${excepcionId}/decision`, cuerpo);
      expect((await decidir(asignador, { decision: 'APROBAR' })).status).toBe(403);
      expect((await decidir(analista, { decision: 'APROBAR' })).status).toBe(403);
      // Un administrador con el permiso, pero que no es quien propuso, sí puede; quien propuso no.
      const propia = await proponer(admin, casoA.solicitudId, {
        ajuste: '-5',
        justificacion: JUSTIFICACION,
      });
      expect(propia.status).toBe(201);
      const mismo = await priPost(admin, `/excepciones/${propia.body.id}/decision`, {
        decision: 'APROBAR',
      });
      expect(mismo.status).toBe(409);
      expect(mismo.body.error.codigo).toBe('MISMA_PERSONA');
      const sinMotivo = await priPost(responsable, `/excepciones/${propia.body.id}/decision`, {
        decision: 'RECHAZAR',
      });
      expect(sinMotivo.status).toBe(422);
      const rechazada = await priPost(responsable, `/excepciones/${propia.body.id}/decision`, {
        decision: 'RECHAZAR',
        motivo: 'No hay evidencia suficiente',
      });
      expect(rechazada.body).toMatchObject({
        estado: 'RECHAZADA',
        decididaPor: responsable.usuario,
      });
      // Aprobada: el ajuste cuenta, el puntaje original se conserva y el caso sube en el listado.
      const ok = await decidir(responsable, {
        decision: 'APROBAR',
        motivo: 'Soporte médico verificado',
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ estado: 'APROBADA', aplicable: true });
      const listado = (await pri(asignador, '/listado')).body.items as {
        radicado: string;
        posicion: number;
      }[];
      const fila = listado.find((x) => x.radicado === casoB.radicado)!;
      expect(fila).toMatchObject({
        puntaje: 35,
        ajuste: 20,
        puntajeFinal: 55,
        excepcionPendiente: false,
      });
      // Con el ajuste pasa del cuarto al segundo lugar.
      expect(fila.posicion).toBe(2);
      const c = (await pri(asignador, `/casos/${casoB.solicitudId}`)).body;
      expect(c).toMatchObject({ puntaje: 35, ajuste: 20, puntajeFinal: 55 });
      expect(c.excepciones).toHaveLength(1);
      // Una excepción decidida no se toca ni se decide de nuevo.
      expect((await decidir(responsable, { decision: 'APROBAR' })).status).toBe(409);
      await expect(
        e.pool.query(`UPDATE priorizacion_excepciones SET ajuste = 99 WHERE id = $1`, [
          excepcionId,
        ]),
      ).rejects.toBeDefined();
      await expect(e.pool.query(`DELETE FROM priorizacion_excepciones`)).rejects.toBeDefined();
      // Ese puntaje ya tiene un ajuste aprobado.
      const otra = await proponer(asignador, casoB.solicitudId, {
        ajuste: '5',
        justificacion: JUSTIFICACION,
      });
      expect(otra.body.error.codigo).toBe('EXCEPCION_YA_APLICADA');
      const bit = await e.pool.query(
        `SELECT accion FROM bitacora WHERE modulo = 'priorizacion' AND accion LIKE 'EXCEPCION%' ORDER BY id`,
      );
      expect(bit.rows.map((x) => x.accion)).toEqual([
        'EXCEPCION_PROPUESTA',
        'EXCEPCION_PROPUESTA',
        'EXCEPCION_RECHAZADA',
        'EXCEPCION_APROBADA',
      ]);
    });
  });

  describe('matriz de ponderación versionada (RF-PRI-02)', () => {
    let borradorId: number;
    let vigenteId: number;

    it('lista las versiones y trae la vigente con sus variables y el puntaje máximo', async () => {
      const lista = await mat(admin);
      expect(lista.body.items).toHaveLength(1);
      expect(lista.body.items[0]).toMatchObject({ version: 1, estado: 'VIGENTE' });
      vigenteId = lista.body.items[0].id;
      const m = (await mat(admin, `/${vigenteId}`)).body;
      expect(m.puntajeMaximo).toBe(90);
      expect(m.variables).toHaveLength(7);
      expect(m.desempateTexto[0]).toContain('Dependencia funcional');
      expect((await mat(admin, '/99999')).status).toBe(404);
    });

    it('se crea un borrador como copia de la vigente y se edita; solo hay uno abierto a la vez', async () => {
      const r = await matPost(admin, '');
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ version: 2, estado: 'BORRADOR', creadaPor: admin.usuario });
      borradorId = r.body.id;
      const otra = await matPost(admin, '');
      expect(otra.status).toBe(409);
      expect(otra.body.error.codigo).toBe('MATRIZ_ABIERTA');
      // Se duplica el peso de la dependencia funcional.
      const def = {
        notas: 'Más peso a la dependencia funcional',
        desempate: r.body.desempate,
        variables: (r.body.variables as { codigo: string; peso: number }[]).map((v) => ({
          ...v,
          peso: v.codigo === 'DEPENDENCIA_FUNCIONAL' ? 2 : v.peso,
        })),
      };
      const mod = await request(e.app)
        .put(`${adm}/matriz/${borradorId}`)
        .set(auth(admin))
        .send(def);
      expect(mod.status, JSON.stringify(mod.body)).toBe(200);
      expect(mod.body.puntajeMaximo).toBe(115);
      const mala = await request(e.app)
        .put(`${adm}/matriz/${borradorId}`)
        .set(auth(admin))
        .send({ ...def, desempate: ['VARIABLE:NO_EXISTE'] });
      expect(mala.status).toBe(422);
      expect(mala.body.error.errores[0].campo).toBe('desempate');
      const sinPuntos = await request(e.app)
        .put(`${adm}/matriz/${borradorId}`)
        .set(auth(admin))
        .send({ ...def, variables: [{ ...def.variables[0], peso: 0 }] });
      expect(sinPuntos.status).toBe(422);
      // La vigente no se edita.
      const vig = await request(e.app).put(`${adm}/matriz/${vigenteId}`).set(auth(admin)).send(def);
      expect(vig.status).toBe(409);
      expect(vig.body.error.codigo).toBe('MATRIZ_NO_EDITABLE');
    });

    it('simula el efecto sobre los casos validados sin guardar nada', async () => {
      const antes = await e.pool.query(`SELECT COUNT(*)::int AS n FROM priorizaciones`);
      const sim = await mat(admin, `/${borradorId}/simulacion`);
      expect(sim.status, JSON.stringify(sim.body)).toBe(200);
      expect(sim.body.resumen).toMatchObject({ casos: 6, conPuntajeActual: 6 });
      expect(sim.body.resumen.cambianPosicion).toBeGreaterThan(0);
      expect(sim.body.matriz).toMatchObject({ version: 2, puntajeMaximo: 115 });
      const b = sim.body.items.find((x: { radicado: string }) => x.radicado === casoB.radicado);
      // Con más peso a la dependencia, B (moderada) pasa de 35 a 50 y supera a tieY (40 → 45).
      expect(b).toMatchObject({ puntajeActual: 35, puntajeSimulado: 50 });
      const y = sim.body.items.find((x: { radicado: string }) => x.radicado === tieY.radicado);
      expect(y).toMatchObject({ puntajeActual: 40, puntajeSimulado: 45 });
      expect(b.posicionSimulada).toBeLessThan(y.posicionSimulada);
      expect(sim.body.items[0].posicionSimulada).toBe(1);
      const despues = await e.pool.query(`SELECT COUNT(*)::int AS n FROM priorizaciones`);
      expect(despues.rows[0].n).toBe(antes.rows[0].n);
      expect((await mat(analista, `/${borradorId}/simulacion`)).status).toBe(403);
    });

    it('la activación la aprueba el responsable, que no puede ser quien la pidió', async () => {
      expect((await matPost(responsable, `/${borradorId}/solicitar-aprobacion`)).status).toBe(403);
      expect((await matPost(admin, `/${vigenteId}/solicitar-aprobacion`)).status).toBe(409);
      const pedida = await matPost(admin, `/${borradorId}/solicitar-aprobacion`);
      expect(pedida.status, JSON.stringify(pedida.body)).toBe(200);
      expect(pedida.body).toMatchObject({ estado: 'EN_APROBACION', solicitadaPor: admin.usuario });
      // Ya no se edita mientras espera.
      const edit = await request(e.app)
        .put(`${adm}/matriz/${borradorId}`)
        .set(auth(admin))
        .send({ notas: '', desempate: [], variables: pedida.body.variables });
      expect(edit.status).toBe(409);
      const decidir = (c: CuentaPrueba, cuerpo: object) =>
        matPost(c, `/${borradorId}/decision`, cuerpo);
      expect((await decidir(asignador, { decision: 'APROBAR' })).status).toBe(403);
      expect((await decidir(admin, { decision: 'APROBAR' })).body.error.codigo).toBe(
        'MISMA_PERSONA',
      );
      expect((await decidir(responsable, { decision: 'RECHAZAR' })).status).toBe(422);
      const ok = await decidir(responsable, {
        decision: 'APROBAR',
        motivo: 'Aprobada por la Gerencia',
      });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ estado: 'VIGENTE', decididaPor: responsable.usuario });
      const lista = (await mat(admin)).body.items as { version: number; estado: string }[];
      expect(lista.map((x) => [x.version, x.estado])).toEqual([
        [2, 'VIGENTE'],
        [1, 'ARCHIVADA'],
      ]);
      // La versión archivada no se toca.
      await expect(
        e.pool.query(
          `UPDATE matriz_opciones SET puntos = 99 WHERE variable_id IN (SELECT id FROM matriz_variables WHERE matriz_id = $1)`,
          [vigenteId],
        ),
      ).rejects.toBeDefined();
      const bit = await e.pool.query(
        `SELECT accion, usuario_id FROM bitacora WHERE modulo = 'priorizacion' AND accion LIKE 'MATRIZ%' ORDER BY id`,
      );
      expect(bit.rows.map((x) => x.accion)).toEqual([
        'MATRIZ_CREADA',
        'MATRIZ_MODIFICADA',
        'MATRIZ_SOLICITADA',
        'MATRIZ_APROBADA',
      ]);
    });

    it('los casos ya calculados conservan su versión; el cálculo masivo con «recalcular» usa la nueva y deja la historia', async () => {
      const antes = (await pri(asignador, `/casos/${tieY.solicitudId}`)).body;
      expect(antes.calculos[0].matrizVersion).toBe(1);
      expect(antes.puntaje).toBe(40);
      // Sin recalcular no cambia nada.
      const nada = await priPost(asignador, '/calcular', {});
      expect(nada.body).toMatchObject({
        matrizVersion: 2,
        calculados: 0,
        sinCambio: 6,
        omitidos: [],
      });
      const masivo = await priPost(asignador, '/calcular', { recalcular: true });
      expect(masivo.status, JSON.stringify(masivo.body)).toBe(200);
      expect(masivo.body).toMatchObject({ matrizVersion: 2, calculados: 6, sinCambio: 0 });
      const despues = (await pri(asignador, `/casos/${tieY.solicitudId}`)).body;
      expect(despues.puntaje).toBe(45);
      expect(
        despues.calculos.map((c: { matrizVersion: number; vigente: boolean }) => [
          c.matrizVersion,
          c.vigente,
        ]),
      ).toEqual([
        [2, true],
        [1, false],
      ]);
      // Una vez recalculado con la versión vigente, otro cálculo masivo no repite nada.
      expect((await priPost(asignador, '/calcular', { recalcular: true })).body.calculados).toBe(0);
      // El ajuste aprobado era del cálculo anterior: ya no se aplica y hay que proponerlo de nuevo.
      const b = (await pri(asignador, `/casos/${casoB.solicitudId}`)).body;
      expect(b).toMatchObject({ puntaje: 50, ajuste: 0, puntajeFinal: 50 });
      expect(b.excepciones[0]).toMatchObject({ estado: 'APROBADA', aplicable: false });
    });

    it('el cálculo individual vuelve a calcular un caso y solo con casos validados', async () => {
      const r = await priPost(asignador, `/casos/${tieX.solicitudId}/calcular`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.puntaje).toBe(55);
      expect(r.body.matrizVersion).toBe(2);
      const aun = await ay.solicitudRadicada();
      expect((await priPost(asignador, `/casos/${aun.solicitudId}/calcular`)).status).toBe(409);
      expect((await priPost(asignador, '/casos/99999/calcular')).status).toBe(404);
      const bit = await e.pool.query(`SELECT 1 FROM bitacora WHERE accion = 'PRIORIZACION_MASIVA'`);
      expect(bit.rowCount).toBe(3);
    });

    it('una versión rechazada queda en la historia y se puede crear otra a partir de ella', async () => {
      const nueva = await matPost(admin, '');
      expect(nueva.body.version).toBe(3);
      await matPost(admin, `/${nueva.body.id}/solicitar-aprobacion`);
      const rechazo = await matPost(responsable, `/${nueva.body.id}/decision`, {
        decision: 'RECHAZAR',
        motivo: 'Los pesos no fueron validados',
      });
      expect(rechazo.body).toMatchObject({
        estado: 'RECHAZADA',
        motivoDecision: 'Los pesos no fueron validados',
      });
      const otra = await matPost(admin, '', { desdeId: nueva.body.id });
      expect(otra.status).toBe(201);
      expect(otra.body.version).toBe(4);
      expect((await matPost(admin, '', { desdeId: 99999 })).status).toBe(404);
    });
  });
});
