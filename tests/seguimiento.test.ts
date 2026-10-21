import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aCsv } from '../src/application/exportacion.js';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';
import { ayudantesSolicitud } from './solicitudes.js';

const adm = '/api/v1/admin';

describe('exportación CSV', () => {
  it('lleva BOM, separador ; y escapa comillas, saltos y separadores', () => {
    const csv = aCsv(
      [
        { clave: 'a', titulo: 'A' },
        { clave: 'b', titulo: 'B' },
      ],
      [
        { a: 'x;y', b: 'dice "hola"' },
        { a: null, b: 3 },
      ],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('A;B\r\n"x;y";"dice ""hola"""\r\n;3\r\n');
  });
});

describe('seguimiento y control (RF-SEG-01, 03, 04, 05, 06, 07)', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let admin: CuentaPrueba;
  let analista: CuentaPrueba;
  let control: CuentaPrueba;
  let validador: CuentaPrueba;
  let asignador: CuentaPrueba;
  let casos: { solicitudId: number; radicado: string }[];

  const get = (c: CuentaPrueba, ruta: string) => request(e.app).get(`${adm}${ruta}`).set(auth(c));
  const binario = (c: CuentaPrueba, ruta: string) =>
    request(e.app)
      .get(`${adm}${ruta}`)
      .set(auth(c))
      .buffer(true)
      .parse((res, cb) => {
        const trozos: Buffer[] = [];
        res.on('data', (t: Buffer) => trozos.push(t));
        res.on('end', () => cb(null, Buffer.concat(trozos)));
      });

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    analista = await crearCuenta(e, 'ANALISTA');
    control = await crearCuenta(e, 'CONTROL_INTERNO');
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    asignador = await crearCuenta(e, 'ASIGNADOR');
    await e.pool.query(
      `UPDATE vigencias SET cupos_totales = 10, valor_estimulo = 500000, presupuesto_total = 50000000 WHERE activa`,
    );
    casos = [
      await ay.validada(validador, {}, { correo: 'seg.a@correo.com' }),
      await ay.validada(validador, {}, { correo: 'seg.b@correo.com' }),
    ];
    const r = await request(e.app)
      .post(`${adm}/asignacion/asignar`)
      .set(auth(asignador))
      .send({ solicitudIds: [casos[0]!.solicitudId] });
    expect(r.status).toBe(201);
  });
  afterAll(async () => {
    await e.cerrar();
  });

  it('cada ruta pide su permiso', async () => {
    expect((await request(e.app).get(`${adm}/bitacora`)).status).toBe(401);
    for (const ruta of [
      '/bitacora',
      '/expedientes?q=abc',
      '/tablero',
      '/reportes',
      '/bi/eventos',
    ]) {
      expect((await get(validador, ruta)).status, ruta).toBe(403);
    }
    expect((await get(control, '/bi/eventos')).status).toBe(403);
    expect((await get(control, '/bitacora')).status).toBe(200);
    expect((await get(analista, '/bi/eventos')).status).toBe(200);
  });

  it('ofrece las listas para filtrar', async () => {
    const r = await get(control, '/seguimiento/filtros');
    expect(r.status).toBe(200);
    expect(r.body.vigencias.length).toBeGreaterThan(0);
    expect(r.body.localidades.length).toBeGreaterThan(0);
    expect(r.body.estados).toContainEqual(expect.objectContaining({ codigo: 'ASIGNADA' }));
    expect((await get(validador, '/seguimiento/filtros')).status).toBe(403);
  });

  describe('bitácora consultable', () => {
    it('filtra por radicado, módulo, acción, usuario y fechas, y pagina', async () => {
      const radicado = casos[0]!.radicado;
      const r = await get(control, `/bitacora?radicado=${radicado}`);
      expect(r.status).toBe(200);
      expect(r.body.total).toBeGreaterThan(0);
      expect(r.body.items.every((x: { radicado: string }) => x.radicado === radicado)).toBe(true);
      const mod = await get(control, '/bitacora?modulo=asignacion');
      expect(mod.body.items.length).toBeGreaterThan(0);
      expect(mod.body.items.every((x: { modulo: string }) => x.modulo === 'asignacion')).toBe(true);
      const acc = await get(control, '/bitacora?accion=BENEFICIO_ASIG');
      expect(acc.body.items[0].accion).toBe('BENEFICIO_ASIGNADO');
      const usu = await get(control, `/bitacora?usuario=${asignador.usuario}`);
      expect(usu.body.items.length).toBeGreaterThan(0);
      const hoy = new Date().toISOString().slice(0, 10);
      expect(
        (await get(control, `/bitacora?desde=${hoy}&hasta=${hoy}`)).body.total,
      ).toBeGreaterThan(0);
      expect((await get(control, '/bitacora?hasta=2020-01-01')).body.total).toBe(0);
      const pag = await get(control, '/bitacora?tamano=2&pagina=2');
      expect(pag.body.items).toHaveLength(2);
      expect((await get(control, '/bitacora?desde=ayer')).status).toBe(422);
      expect((await get(control, '/bitacora/modulos')).body.items).toContain('asignacion');
      expect((await get(control, '/bitacora/acciones')).body.items).toContain('BENEFICIO_ASIGNADO');
    });

    it('consultar la bitácora queda registrado y quien no ve datos sensibles no recibe los valores', async () => {
      await get(control, '/bitacora?modulo=validacion');
      const r = await e.pool.query(
        `SELECT detalle FROM bitacora WHERE accion = 'BITACORA_CONSULTADA' ORDER BY id DESC LIMIT 1`,
      );
      expect(r.rows[0].detalle.filtros.modulo).toBe('validacion');
      const lista = await get(control, '/bitacora?modulo=asignacion');
      expect(lista.body.sensiblesOcultos).toBe(true);
      expect(lista.body.items.every((x: { nuevo: unknown }) => x.nuevo === null)).toBe(true);
      const completa = await get(admin, '/bitacora?modulo=asignacion');
      expect(completa.body.sensiblesOcultos).toBe(false);
    });
  });

  describe('expediente integral', () => {
    it('busca por radicado, documento o nombre', async () => {
      const r = await get(control, `/expedientes?q=${casos[0]!.radicado}`);
      expect(r.body.items).toHaveLength(1);
      expect(r.body.items[0].solicitudId).toBe(casos[0]!.solicitudId);
      expect((await get(control, '/expedientes?q=ab')).status).toBe(422);
    });

    it('reúne la cronología del caso y oculta lo sensible a quien no tiene permiso', async () => {
      const id = casos[0]!.solicitudId;
      const r = await get(control, `/expedientes/${id}`);
      expect(r.status).toBe(200);
      expect(r.body.radicado).toBe(casos[0]!.radicado);
      expect(r.body.beneficio.estado).toBe('PENDIENTE_ENTREGA');
      expect(r.body.puntaje.total).toBeGreaterThan(0);
      expect(r.body.documentos.length).toBeGreaterThan(0);
      const acciones = r.body.cronologia.map((x: { accion: string }) => x.accion);
      expect(acciones).toContain('BENEFICIO_ASIGNADO');
      const fechas = r.body.cronologia.map((x: { fecha: string }) => x.fecha);
      expect([...fechas].sort()).toEqual(fechas);
      expect(r.body.sensiblesOcultos).toBe(true);
      expect(r.body.correo).toBeNull();
      expect(r.body.pcd.numeroIdentificacion).toMatch(/^\*\*\*/);
      const completo = await get(admin, `/expedientes/${id}`);
      expect(completo.body.sensiblesOcultos).toBe(false);
      expect(completo.body.pcd.numeroIdentificacion).not.toMatch(/^\*\*\*/);
      expect(completo.body.correo).toBe('seg.a@correo.com');
    });

    it('consultarlo queda en la bitácora y uno inexistente da 404', async () => {
      const id = casos[1]!.solicitudId;
      await get(control, `/expedientes/${id}`);
      const r = await e.pool.query(
        `SELECT usuario_id FROM bitacora WHERE accion = 'EXPEDIENTE_CONSULTADO' AND solicitud_id = $1`,
        [id],
      );
      expect(r.rows).toHaveLength(1);
      expect((await get(control, '/expedientes/999999')).status).toBe(404);
    });
  });

  describe('tablero', () => {
    it('cuenta cada etapa, el avance contra la meta y la ejecución presupuestal', async () => {
      const r = await get(control, '/tablero');
      expect(r.status).toBe(200);
      expect(r.body.embudo).toMatchObject({
        preinscritos: 2,
        caracterizados: 2,
        asignados: 1,
        activos: 0,
      });
      expect(r.body.avance).toMatchObject({ meta: 3000, asignadosVigentes: 1 });
      expect(r.body.presupuesto).toMatchObject({
        total: 50000000,
        comprometido: 1000000,
        cupos: 10,
      });
      expect(r.body.presupuesto.disponible).toBe(49000000);
      expect(r.body.tiemposPromedioDias).toHaveProperty('validacion');
      expect(r.body.porLocalidad.length).toBeGreaterThan(0);
    });

    it('filtra por etapa y población', async () => {
      const asignada = await get(control, '/tablero?etapa=ASIGNADA');
      expect(asignada.body.embudo.preinscritos).toBe(1);
      const sin = await get(control, '/tablero?poblacion=SIN_CUIDADOR');
      const con = await get(control, '/tablero?poblacion=CON_CUIDADOR');
      expect(sin.body.embudo.preinscritos + con.body.embudo.preinscritos).toBe(2);
      expect((await get(control, '/tablero?poblacion=otra')).status).toBe(422);
    });
  });

  describe('reportes', () => {
    it('lista los siete reportes y cada uno devuelve su tabla con filtros comunes', async () => {
      const lista = await get(control, '/reportes');
      expect(lista.body.items).toHaveLength(7);
      for (const { codigo } of lista.body.items as { codigo: string }[]) {
        const r = await get(control, `/reportes/${codigo}`);
        expect(r.status, codigo).toBe(200);
        expect(r.body.columnas.length, codigo).toBeGreaterThan(0);
        expect(r.body.filtros[0]).toMatch(/^Vigencia: /);
      }
      const ben = await get(control, '/reportes/BENEFICIARIOS');
      expect(ben.body.total).toBe(1);
      expect(ben.body.filas[0].documento).toMatch(/^\*\*\*/);
      expect((await get(admin, '/reportes/BENEFICIARIOS')).body.filas[0].documento).not.toMatch(
        /^\*\*\*/,
      );
      const prio = await get(control, '/reportes/LISTADO_PRIORIZADO');
      expect(prio.body.filas.map((f: { posicion: number }) => f.posicion)).toEqual([1, 2]);
      const estado = await get(control, '/reportes/SOLICITUDES_POR_ESTADO?estado=ASIGNADA');
      expect(estado.body.filas).toEqual([
        expect.objectContaining({ estado: 'ASIGNADA', cantidad: 1 }),
      ]);
      expect((await get(control, '/reportes/BENEFICIARIOS?hasta=2020-01-01')).body.total).toBe(0);
      expect((await get(control, '/reportes/NO_EXISTE')).status).toBe(422);
    });

    it('exporta a Excel y PDF, registra la exportación y la deja en la bitácora', async () => {
      const xlsx = await binario(control, '/reportes/BENEFICIARIOS/exportar?formato=XLSX');
      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toContain('spreadsheetml');
      expect(xlsx.headers['content-disposition']).toContain('beneficiarios-');
      expect((xlsx.body as Buffer).subarray(0, 2).toString()).toBe('PK');

      const pdf = await binario(control, '/reportes/ENTREGAS/exportar?formato=PDF');
      expect(pdf.status).toBe(200);
      expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');

      const hist = await get(control, '/reportes/exportaciones');
      expect(hist.body.items).toHaveLength(2);
      expect(hist.body.items[0]).toMatchObject({
        reporte: 'ENTREGAS',
        formato: 'PDF',
        usuario: control.usuario,
      });
      expect(hist.body.items[1].sha256).toMatch(/^[0-9a-f]{64}$/);
      const b = await e.pool.query(`SELECT 1 FROM bitacora WHERE accion = 'REPORTE_EXPORTADO'`);
      expect(b.rowCount).toBe(2);
    });

    it('rechaza formatos no admitidos y una exportación registrada no se puede alterar', async () => {
      expect((await get(control, '/reportes/BENEFICIARIOS/exportar?formato=DOC')).status).toBe(422);
      await expect(e.pool.query(`UPDATE exportaciones SET filas = 0`)).rejects.toThrow();
      await expect(e.pool.query(`DELETE FROM exportaciones`)).rejects.toThrow();
    });
  });

  describe('eventos para BI', () => {
    it('entrega eventos sin datos personales ni consultas, paginados', async () => {
      const r = await get(analista, '/bi/eventos?limite=5');
      expect(r.status).toBe(200);
      expect(r.body.items).toHaveLength(5);
      expect(r.body.siguiente).toBe(r.body.items.at(-1).eventoId);
      expect(Object.keys(r.body.items[0]).sort()).toEqual(
        [
          'casoRef',
          'estado',
          'etapa',
          'eventoId',
          'localidad',
          'ocurridoAt',
          'tipoEvento',
          'usuarioRef',
          'vigencia',
        ].sort(),
      );
      const sig = await get(analista, `/bi/eventos?limite=5&despuesDe=${r.body.siguiente}`);
      expect(sig.body.items[0].eventoId).toBeGreaterThan(r.body.siguiente);
      const todos = await get(analista, '/bi/eventos?limite=5000');
      const tipos = new Set<string>(
        todos.body.items.map((x: { tipoEvento: string }) => x.tipoEvento),
      );
      expect(tipos.has('BENEFICIO_ASIGNADO')).toBe(true);
      expect([...tipos].some((t) => t.startsWith('LOGIN') || t === 'BITACORA_CONSULTADA')).toBe(
        false,
      );
      const ref = todos.body.items.find((x: { casoRef: string | null }) => x.casoRef)?.casoRef;
      expect(ref).toMatch(/^[0-9a-f]{16}$/);
    });

    it('también sale como CSV', async () => {
      const r = await request(e.app)
        .get(`${adm}/bi/eventos?formato=csv&limite=3`)
        .set(auth(analista));
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('text/csv');
      expect(r.text.split('\r\n')[0]).toContain('evento_id;ocurrido_at;tipo_evento');
    });
  });
});
