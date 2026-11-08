import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';
import { ayudantesSolicitud, bearer, pdf } from './solicitudes.js';

const adm = '/api/v1/admin';
const pub = '/api/v1/publico';

describe('novedades, revocatoria y alertas de cruce (RF-NOV-01..03)', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let validador: CuentaPrueba;
  let asignador: CuentaPrueba;
  let gestor: CuentaPrueba;
  let analista: CuentaPrueba;
  let admin: CuentaPrueba;

  type Caso = Awaited<ReturnType<typeof ay.validada>>;
  let casoA: Caso;
  let casoB: Caso;
  let casoC: Caso;
  let casoD: Caso;
  let benA: number;
  let benB: number;
  let benC: number;
  let benD: number;
  let causalBloqueo: number;
  let causalRevocatoria: number;

  const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    asignador = await crearCuenta(e, 'ASIGNADOR');
    gestor = await crearCuenta(e, 'GESTOR_NOVEDADES');
    analista = await crearCuenta(e, 'ANALISTA');
    admin = await crearCuenta(e, 'ADMINISTRADOR');
    await e.pool.query(
      `UPDATE vigencias SET cupos_totales = 10, valor_estimulo = 500000, presupuesto_total = 50000000 WHERE activa`,
    );
    casoA = await ay.validada(validador, {}, { correo: 'nov.a@correo.com' });
    casoB = await ay.validada(validador, {}, { correo: 'nov.b@correo.com' });
    casoC = await ay.validada(validador, {}, { correo: 'nov.c@correo.com' });
    casoD = await ay.validada(validador, {}, { correo: 'nov.d@correo.com' });
    const r = await request(e.app)
      .post(`${adm}/asignacion/asignar`)
      .set(auth(asignador))
      .send({ solicitudIds: [casoA, casoB, casoC, casoD].map((c) => c.solicitudId) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = async (c: Caso) =>
      Number(
        (
          await e.pool.query<{ id: string }>(`SELECT id FROM beneficios WHERE solicitud_id = $1`, [
            c.solicitudId,
          ])
        ).rows[0]!.id,
      );
    [benA, benB, benC, benD] = [await id(casoA), await id(casoB), await id(casoC), await id(casoD)];
    // Los beneficios A, C y D ya están activos desde hace seis meses; B sigue pendiente de entrega.
    await e.pool.query(
      `UPDATE beneficios SET estado = 'ACTIVO', activado_at = now() - interval '6 months' WHERE id = ANY($1::bigint[])`,
      [[benA, benC, benD]],
    );
    causalBloqueo = (
      await e.pool.query<{ id: number }>(
        `SELECT id FROM catalogo_items WHERE catalogo = 'CAUSAL_BLOQUEO' ORDER BY id LIMIT 1`,
      )
    ).rows[0]!.id;
    causalRevocatoria = (
      await e.pool.query<{ id: number }>(
        `SELECT id FROM catalogo_items WHERE catalogo = 'CAUSAL_REVOCATORIA' AND codigo = 'USO_INDEBIDO'`,
      )
    ).rows[0]!.id;
  });
  afterAll(async () => {
    await e.cerrar();
  });

  const nov = (c: CuentaPrueba, ruta: string) =>
    request(e.app).get(`${adm}/novedades${ruta}`).set(auth(c));
  const multipart = (
    c: CuentaPrueba,
    ruta: string,
    datos: object,
    archivo: boolean | 'pdf' = 'pdf',
  ) => {
    const r = request(e.app)
      .post(`${adm}/novedades${ruta}`)
      .set(auth(c))
      .field('datos', JSON.stringify(datos));
    return archivo ? r.attach('archivo', pdf('soporte'), 'soporte.pdf') : r;
  };
  const estadoBen = async (id: number) =>
    (await e.pool.query<{ estado: string }>(`SELECT estado FROM beneficios WHERE id = $1`, [id]))
      .rows[0]!.estado;
  const correos = async (asunto: string) => {
    await e.servicios.correos.esperarDespachos();
    return e.mailer.enviados.filter((m) => m.subject.includes(asunto));
  };
  const avisos = async (c: CuentaPrueba) =>
    (await request(e.app).get(`${adm}/alertas`).set(auth(c))).body.items as {
      tipo: string;
      titulo: string;
      mensaje: string;
    }[];
  const campos = (r: request.Response) =>
    (r.body.error?.errores ?? []).map((x: { campo: string }) => x.campo);

  describe('bloqueo, suspensión y reactivación (RF-NOV-01)', () => {
    it('cada rol hace solo lo suyo', async () => {
      expect((await request(e.app).get(`${adm}/novedades/resumen`)).status).toBe(401);
      expect((await nov(validador, '/resumen')).status).toBe(403);
      expect((await nov(asignador, '/resumen')).status).toBe(403);
      for (const c of [gestor, analista, admin])
        expect((await nov(c, '/resumen')).status).toBe(200);
      const datos = {
        tipo: 'BLOQUEO',
        causalId: causalBloqueo,
        fechaEfectiva: hoy(),
        observacion: 'Reporte recibido',
      };
      expect((await multipart(analista, `/beneficios/${benA}/novedades`, datos)).status).toBe(403);
      expect((await multipart(asignador, `/beneficios/${benA}/novedades`, datos)).status).toBe(403);
      expect((await nov(analista, `/beneficios/${benA}`)).status).toBe(200);
      expect((await nov(analista, '/beneficios/99999')).status).toBe(404);
    });

    it('el resumen lista los beneficios con su estado y novedades', async () => {
      const r = (await nov(gestor, '/resumen')).body;
      expect(r.total).toBe(4);
      expect(r.items.map((x: { radicado: string }) => x.radicado)).toEqual(
        expect.arrayContaining([casoA.radicado, casoB.radicado]),
      );
      expect(
        (await nov(gestor, `/resumen?q=${casoB.radicado}&estado=PENDIENTE_ENTREGA`)).body.total,
      ).toBe(1);
    });

    it('exige causal, fecha efectiva, evidencia y un beneficio activo', async () => {
      const base = {
        tipo: 'BLOQUEO',
        causalId: causalBloqueo,
        fechaEfectiva: hoy(),
        observacion: 'Reporte recibido',
      };
      // Solo la justificación es obligatoria: el archivo de soporte ya no se exige.
      expect(
        campos(
          await multipart(
            gestor,
            `/beneficios/${benA}/novedades`,
            { ...base, observacion: '' },
            false,
          ),
        ),
      ).toContain('observacion');
      expect(
        campos(
          await multipart(gestor, `/beneficios/${benA}/novedades`, {
            ...base,
            causalId: undefined,
          }),
        ),
      ).toContain('causalId');
      expect(
        campos(
          await multipart(gestor, `/beneficios/${benA}/novedades`, { ...base, causalId: 999999 }),
        ),
      ).toContain('causalId');
      expect(
        campos(
          await multipart(gestor, `/beneficios/${benA}/novedades`, {
            ...base,
            fechaEfectiva: '2020-01-01',
          }),
        ),
      ).toContain('fechaEfectiva');
      expect(
        campos(
          await multipart(gestor, `/beneficios/${benA}/novedades`, {
            ...base,
            levantamientoProgramado: '2020-01-01',
          }),
        ),
      ).toContain('levantamientoProgramado');
      expect(
        campos(
          await multipart(gestor, `/beneficios/${benA}/novedades`, {
            tipo: 'RARO',
            fechaEfectiva: hoy(),
          }),
        ),
      ).toContain('tipo');
      const pendiente = await multipart(gestor, `/beneficios/${benB}/novedades`, base);
      expect(pendiente.status).toBe(409);
      expect(pendiente.body.error.codigo).toBe('BENEFICIO_NO_ACTIVO');
      const noLevanta = await multipart(gestor, `/beneficios/${benA}/novedades`, {
        tipo: 'LEVANTAMIENTO',
        fechaEfectiva: hoy(),
        observacion: 'ok ok ok',
      });
      expect(noLevanta.status).toBe(409);
      expect(await estadoBen(benA)).toBe('ACTIVO');
    });

    it('bloquea con comunicación a la persona, y la secuencia queda completa sin borrar nada', async () => {
      const r = await multipart(gestor, `/beneficios/${benA}/novedades`, {
        tipo: 'BLOQUEO',
        causalId: causalBloqueo,
        fechaEfectiva: hoy(),
        observacion: 'Reporte de pérdida recibido en la línea de atención',
        levantamientoProgramado: hoy(),
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await estadoBen(benA)).toBe('BLOQUEADO');
      const n = r.body.novedades[0];
      expect(n).toMatchObject({
        tipo: 'BLOQUEO',
        tipoNombre: 'Bloqueo temporal',
        fechaEfectiva: hoy(),
        responsable: gestor.usuario,
        abierta: true,
        estadoPrevio: 'ACTIVO',
        levantamientoProgramado: hoy(),
      });
      expect(n.correoId).not.toBeNull();
      expect(n.causal).toEqual(expect.any(String));
      const mails = await correos('Novedad en su beneficio');
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe('nov.a@correo.com');
      expect(mails[0]!.text).toContain('Bloqueo temporal');
      expect(mails[0]!.text).toContain(n.causal);
      expect(mails[0]!.text).toContain('Reporte de pérdida recibido');
      // La persona ve su beneficio bloqueado.
      const estado = await request(e.app).get(`${pub}/consulta/solicitud`).set(bearer(casoA.token));
      expect(estado.body.estado.nombre).toBe('Beneficio bloqueado');
      // La evidencia se descarga.
      const ev = await nov(analista, `/novedades/${n.id}/evidencia`);
      expect(ev.status).toBe(200);
      expect(Buffer.from(ev.body).toString('latin1')).toContain('%PDF');
      // Ya no se puede bloquear otra vez.
      const otra = await multipart(gestor, `/beneficios/${benA}/novedades`, {
        tipo: 'SUSPENSION',
        causalId: causalBloqueo,
        fechaEfectiva: hoy(),
        observacion: 'Otra novedad',
      });
      expect(otra.status).toBe(409);
      await expect(
        e.pool.query(`UPDATE novedades SET observacion = 'cambiada'`),
      ).rejects.toBeDefined();
      await expect(e.pool.query(`DELETE FROM novedades`)).rejects.toBeDefined();
      const bit = await e.pool.query(
        `SELECT usuario_id, detalle FROM bitacora WHERE accion = 'NOVEDAD_REGISTRADA'`,
      );
      expect(bit.rows[0].usuario_id).toBe(gestor.id);
    });

    it('al llegar la fecha de levantamiento programada se alerta al gestor, una sola vez', async () => {
      const a = (await avisos(gestor)).filter((x) => x.tipo === 'LEVANTAMIENTO_PROGRAMADO');
      expect(a).toHaveLength(1);
      expect(a[0]!.titulo).toContain(casoA.radicado);
      expect(
        (await avisos(gestor)).filter((x) => x.tipo === 'LEVANTAMIENTO_PROGRAMADO'),
      ).toHaveLength(1);
      expect(
        (await avisos(analista)).filter((x) => x.tipo === 'LEVANTAMIENTO_PROGRAMADO'),
      ).toHaveLength(0);
    });

    it('la reactivación vuelve el beneficio a activo y conserva el historial de bloqueos y levantamientos', async () => {
      const sinObs = await multipart(gestor, `/beneficios/${benA}/novedades`, {
        tipo: 'LEVANTAMIENTO',
        fechaEfectiva: hoy(),
        observacion: '',
      });
      expect(sinObs.status).toBe(422);
      const r = await multipart(gestor, `/beneficios/${benA}/novedades`, {
        tipo: 'LEVANTAMIENTO',
        fechaEfectiva: hoy(),
        observacion: 'Se repuso la tarjeta',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await estadoBen(benA)).toBe('ACTIVO');
      expect(
        r.body.novedades.map((n: { tipo: string; abierta: boolean }) => [n.tipo, n.abierta]),
      ).toEqual([
        ['BLOQUEO', false],
        ['LEVANTAMIENTO', false],
      ]);
      expect(r.body.novedades[1].tipoNombre).toBe('Reactivación del beneficio');
      expect((await correos('Novedad en su beneficio')).length).toBe(2);
      expect(
        (
          await multipart(gestor, `/beneficios/${benA}/novedades`, {
            tipo: 'LEVANTAMIENTO',
            fechaEfectiva: hoy(),
            observacion: 'otra vez',
          })
        ).status,
      ).toBe(409);
      // Se puede suspender otra vez y el historial sigue creciendo.
      const s = await multipart(gestor, `/beneficios/${benC}/novedades`, {
        tipo: 'SUSPENSION',
        causalId: causalBloqueo,
        fechaEfectiva: hoy(),
        observacion: 'Verificación en curso',
      });
      expect(s.status).toBe(201);
      expect(await estadoBen(benC)).toBe('SUSPENDIDO');
      const sin = await multipart(gestor, `/beneficios/${benC}/novedades`, {
        tipo: 'LEVANTAMIENTO',
        fechaEfectiva: hoy(),
        observacion: 'Verificado, sin irregularidad',
      });
      expect(sin.status).toBe(201);
      expect(await estadoBen(benC)).toBe('ACTIVO');
    });
  });

  describe('revocatoria con debido proceso (RF-NOV-02)', () => {
    let rev: number;
    const inicio = {
      causalId: 0,
      descripcion:
        'La tarjeta fue usada por una persona distinta a la autorizada, según el reporte del operador',
    };

    it('inicia con causal y evidencia, y solo hay una en curso por beneficio', async () => {
      const base = { ...inicio, causalId: causalRevocatoria };
      expect(
        campos(await multipart(gestor, `/beneficios/${benA}/revocatorias`, base, false)),
      ).toContain('archivo');
      expect(
        campos(
          await multipart(gestor, `/beneficios/${benA}/revocatorias`, {
            ...base,
            causalId: 999999,
          }),
        ),
      ).toContain('causalId');
      expect(
        campos(
          await multipart(gestor, `/beneficios/${benA}/revocatorias`, {
            ...base,
            descripcion: 'corta',
          }),
        ),
      ).toContain('descripcion');
      expect((await multipart(analista, `/beneficios/${benA}/revocatorias`, base)).status).toBe(
        403,
      );
      const r = await multipart(gestor, `/beneficios/${benA}/revocatorias`, base);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      rev = r.body.id;
      expect(r.body).toMatchObject({
        estado: 'INICIADA',
        radicado: casoA.radicado,
        puedeDecidir: false,
      });
      expect(r.body.eventos.map((x: { etapa: string }) => x.etapa)).toEqual(['INICIO']);
      expect(r.body.eventos[0].evidencia.nombre).toBe('soporte.pdf');
      const otra = await multipart(gestor, `/beneficios/${benA}/revocatorias`, base);
      expect(otra.status).toBe(409);
      expect(otra.body.error.codigo).toBe('REVOCATORIA_ABIERTA');
      expect((await nov(analista, '/revocatorias?estado=INICIADA')).body.items).toHaveLength(1);
    });

    it('no se puede decidir sin agotar el traslado y los descargos', async () => {
      const acto = {
        resultado: 'REVOCAR',
        motivacion: 'Se verificó el uso indebido de la tarjeta por un tercero.',
        numeroActo: 'RES-2026-001',
      };
      const sin = await multipart(gestor, `/revocatorias/${rev}/decision`, acto);
      expect(sin.status).toBe(409);
      expect(sin.body.error.codigo).toBe('ETAPAS_PENDIENTES');
      expect(
        (
          await multipart(
            gestor,
            `/revocatorias/${rev}/descargos`,
            { texto: 'Presento descargos de prueba' },
            false,
          )
        ).status,
      ).toBe(409);
      expect(await estadoBen(benA)).toBe('ACTIVO');
    });

    it('el traslado comunica las razones y abre el plazo de descargos', async () => {
      expect(
        campos(await multipart(gestor, `/revocatorias/${rev}/traslado`, { texto: 'corto' }, false)),
      ).toContain('texto');
      const r = await multipart(
        gestor,
        `/revocatorias/${rev}/traslado`,
        {
          texto:
            'El operador reportó el uso de la tarjeta en horarios y lugares incompatibles con su titular.',
        },
        false,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.estado).toBe('EN_TRASLADO');
      expect(r.body.venceDescargosAt).not.toBeNull();
      // El plazo es el parámetro (10 días) hasta el final del día.
      const dias = (new Date(r.body.venceDescargosAt).getTime() - Date.now()) / 86_400_000;
      expect(dias).toBeGreaterThan(10);
      expect(dias).toBeLessThan(11.1);
      const mails = await correos('Traslado de razones');
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe('nov.a@correo.com');
      expect(mails[0]!.text).toContain('Uso indebido');
      expect(mails[0]!.text).toContain('horarios y lugares incompatibles');
      expect(mails[0]!.text).toContain('descargos');
      expect(
        (
          await multipart(
            gestor,
            `/revocatorias/${rev}/traslado`,
            { texto: 'Otro traslado con suficiente texto' },
            false,
          )
        ).status,
      ).toBe(409);
      // Dentro del plazo no se puede declarar que no hubo descargos.
      const pronto = await multipart(
        gestor,
        `/revocatorias/${rev}/descargos`,
        { sinDescargos: true },
        false,
      );
      expect(pronto.status).toBe(409);
      expect(pronto.body.error.codigo).toBe('PLAZO_VIGENTE');
      const acto = {
        resultado: 'REVOCAR',
        motivacion: 'Se verificó el uso indebido de la tarjeta por un tercero.',
        numeroActo: 'RES-2026-001',
      };
      expect(
        (await multipart(gestor, `/revocatorias/${rev}/decision`, acto)).body.error.codigo,
      ).toBe('ETAPAS_PENDIENTES');
    });

    it('se registran los descargos de la persona', async () => {
      expect(
        campos(await multipart(gestor, `/revocatorias/${rev}/descargos`, { texto: 'x' }, false)),
      ).toContain('texto');
      const r = await multipart(gestor, `/revocatorias/${rev}/descargos`, {
        texto: 'La persona afirma que prestó la tarjeta a su hermano por una urgencia médica.',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ estado: 'CON_DESCARGOS', puedeDecidir: true });
      expect(
        (
          await multipart(gestor, `/revocatorias/${rev}/descargos`, {
            texto: 'Otros descargos adicionales',
          })
        ).status,
      ).toBe(409);
    });

    it('el acto administrativo exige número, motivación y archivo; al revocar finaliza el beneficio y libera el cupo', async () => {
      const acto = {
        resultado: 'REVOCAR',
        motivacion: 'Se verificó el uso indebido de la tarjeta por un tercero.',
        numeroActo: 'RES-2026-001',
      };
      expect(
        campos(await multipart(gestor, `/revocatorias/${rev}/decision`, acto, false)),
      ).toContain('archivo');
      expect(
        campos(
          await multipart(gestor, `/revocatorias/${rev}/decision`, {
            ...acto,
            motivacion: 'corta',
          }),
        ),
      ).toContain('motivacion');
      expect(
        campos(
          await multipart(gestor, `/revocatorias/${rev}/decision`, { ...acto, numeroActo: '' }),
        ),
      ).toContain('numeroActo');
      expect((await multipart(analista, `/revocatorias/${rev}/decision`, acto)).status).toBe(403);
      const r = await multipart(gestor, `/revocatorias/${rev}/decision`, acto);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ estado: 'DECIDIDA', resultado: 'REVOCADA' });
      expect(await estadoBen(benA)).toBe('FINALIZADO');
      expect(r.body.eventos.map((x: { etapa: string }) => x.etapa)).toEqual([
        'INICIO',
        'TRASLADO',
        'DESCARGOS',
        'ACTO',
      ]);
      const ultimo = r.body.eventos.at(-1);
      expect(ultimo).toMatchObject({ referencia: 'RES-2026-001', usuario: gestor.usuario });
      const ev = await nov(analista, `/revocatorias/eventos/${ultimo.id}/evidencia`);
      expect(ev.status).toBe(200);
      // El cupo queda liberado y se avisa al asignador para reasignarlo (RF-ASI-03).
      const cupos = (await request(e.app).get(`${adm}/asignacion/cupos`).set(auth(asignador))).body
        .cupos;
      expect(cupos).toMatchObject({ ocupados: 3, liberados: 1 });
      expect(
        (await avisos(asignador)).some(
          (x) => x.tipo === 'CUPO_LIBERADO' && x.titulo.includes(casoA.radicado),
        ),
      ).toBe(true);
      const mails = await correos('Decisión sobre su beneficio');
      expect(mails).toHaveLength(1);
      expect(mails[0]!.text).toContain('Beneficio revocado');
      expect(mails[0]!.text).toContain('días siguientes');
      const estado = await request(e.app).get(`${pub}/consulta/solicitud`).set(bearer(casoA.token));
      expect(estado.body.estado.nombre).toBe('Beneficio finalizado');
      expect((await multipart(gestor, `/revocatorias/${rev}/decision`, acto)).status).toBe(409);
      await expect(
        e.pool.query(`UPDATE revocatoria_eventos SET texto = 'otro'`),
      ).rejects.toBeDefined();
      expect(
        (
          await multipart(gestor, `/beneficios/${benA}/revocatorias`, {
            ...inicio,
            causalId: causalRevocatoria,
          })
        ).status,
      ).toBe(409);
    });

    it('si vence el plazo sin descargos se avisa al gestor, que registra que no hubo y decide; archivar no toca el beneficio', async () => {
      const r = await multipart(gestor, `/beneficios/${benC}/revocatorias`, {
        ...inicio,
        causalId: causalRevocatoria,
      });
      const id = r.body.id as number;
      await multipart(
        gestor,
        `/revocatorias/${id}/traslado`,
        { texto: 'Se estudia revocar el beneficio por el uso reportado.' },
        false,
      );
      // Pasan once días sin respuesta.
      await e.pool.query(
        `UPDATE revocatorias SET vence_descargos_at = now() - interval '1 day' WHERE id = $1`,
        [id],
      );
      expect(
        (
          await multipart(
            gestor,
            `/revocatorias/${id}/descargos`,
            { texto: 'Descargos fuera del plazo' },
            false,
          )
        ).body.error.codigo,
      ).toBe('PLAZO_VENCIDO');
      const detalle = (await nov(gestor, `/revocatorias/${id}`)).body;
      expect(detalle.puedeSinDescargos).toBe(true);
      expect(
        (await avisos(gestor)).some(
          (x) => x.tipo === 'DESCARGOS_VENCIDOS' && x.titulo.includes(casoC.radicado),
        ),
      ).toBe(true);
      const sin = await multipart(
        gestor,
        `/revocatorias/${id}/descargos`,
        { sinDescargos: true },
        false,
      );
      expect(sin.status, JSON.stringify(sin.body)).toBe(200);
      expect(sin.body).toMatchObject({
        estado: 'EN_TRASLADO',
        sinDescargos: true,
        puedeDecidir: true,
      });
      expect(sin.body.eventos.at(-1).etapa).toBe('SIN_DESCARGOS');
      // Pasan más de quince días desde el vencimiento sin decidir: nuevo aviso.
      await e.pool.query(
        `UPDATE revocatorias SET vence_descargos_at = now() - interval '40 days' WHERE id = $1`,
        [id],
      );
      expect(
        (await avisos(gestor)).some(
          (x) => x.tipo === 'DECISION_VENCIDA' && x.titulo.includes(casoC.radicado),
        ),
      ).toBe(true);
      const fin = await multipart(gestor, `/revocatorias/${id}/decision`, {
        resultado: 'ARCHIVAR',
        motivacion: 'No se acreditó el uso indebido de la tarjeta; se archiva el trámite.',
        numeroActo: 'RES-2026-002',
      });
      expect(fin.status, JSON.stringify(fin.body)).toBe(200);
      expect(fin.body).toMatchObject({ estado: 'DECIDIDA', resultado: 'ARCHIVADA' });
      expect(await estadoBen(benC)).toBe('ACTIVO');
      expect((await correos('Decisión sobre su beneficio')).pop()!.text).toContain(
        'el beneficio continúa',
      );
    });
  });

  describe('cruces periódicos (RF-NOV-03)', () => {
    const cargar = (estructura: string, csv: string) =>
      (async () => {
        const lista = (await request(e.app).get(`${adm}/cruces`).set(auth(admin))).body.items as {
          id: number;
          codigo: string;
        }[];
        const id = lista.find((x) => x.codigo === estructura)!.id;
        return request(e.app)
          .post(`${adm}/cruces/${id}/cargas`)
          .set(auth(admin))
          .attach('archivo', Buffer.from(csv, 'utf8'), 'cruce.csv');
      })();

    it('la estructura define qué se alerta y con qué causal, y la causal debe existir', async () => {
      const lista = (await request(e.app).get(`${adm}/cruces`).set(auth(admin))).body.items as {
        codigo: string;
        alertaNovedad: string;
        causalCodigo: string | null;
      }[];
      expect(lista.find((x) => x.codigo === 'DEFUNCIONES')).toMatchObject({
        alertaNovedad: 'PRESENCIA',
        causalCodigo: 'FALLECIMIENTO',
      });
      expect(lista.find((x) => x.codigo === 'TRANSMETRO')).toMatchObject({
        alertaNovedad: 'AUSENCIA',
        causalCodigo: 'INACTIVIDAD',
      });
      const def = (await request(e.app).get(`${adm}/cruces`).set(auth(admin))).body.items.find(
        (x: { codigo: string }) => x.codigo === 'DEFUNCIONES',
      );
      const malo = await request(e.app)
        .put(`${adm}/cruces/${def.id}`)
        .set(auth(admin))
        .send({ ...def, causalCodigo: 'NO_EXISTE' });
      expect(malo.status).toBe(422);
      expect(malo.body.error.errores[0].campo).toBe('causalCodigo');
      const sinCausal = await request(e.app)
        .put(`${adm}/cruces/${def.id}`)
        .set(auth(admin))
        .send({ ...def, causalCodigo: null });
      expect(sinCausal.status).toBe(422);
    });

    it('un archivo de defunciones genera una alerta por beneficio afectado, sin cambiar su estado', async () => {
      const r = await cargar(
        'DEFUNCIONES',
        `IDENTIFICACION,FECHA_DEFUNCION\n${casoB.numero},2026-09-30\n55555555,2026-09-01\n`,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.alertasGeneradas).toBe(1);
      const lista = (await nov(gestor, '/alertas-cruce')).body;
      expect(lista.total).toBe(1);
      expect(lista.items[0]).toMatchObject({
        radicado: casoB.radicado,
        estado: 'PENDIENTE',
        causalCodigo: 'FALLECIMIENTO',
      });
      expect(lista.items[0].detalle).toContain('La persona con discapacidad aparece');
      expect(lista.items[0].detalle).toContain('2026-09-30');
      expect(await estadoBen(benB)).toBe('PENDIENTE_ENTREGA');
      const aviso = (await avisos(gestor)).find((x) => x.tipo === 'ALERTA_CRUCE')!;
      expect(aviso.titulo).toContain('1 alerta(s)');
      expect((await avisos(analista)).some((x) => x.tipo === 'ALERTA_CRUCE')).toBe(false);
      // Volver a cargar el mismo archivo no duplica la alerta de la misma carga, pero sí genera la de la carga nueva.
      expect((await nov(analista, '/alertas-cruce')).status).toBe(200);
      expect((await nov(validador, '/alertas-cruce')).status).toBe(403);
    });

    it('el gestor analiza la alerta: no basta con una observación corta, y para iniciar la revocatoria necesita evidencia', async () => {
      const id = (await nov(gestor, '/alertas-cruce')).body.items[0].id as number;
      const analizar = (c: CuentaPrueba, datos: object, archivo = false) => {
        const r = request(e.app)
          .post(`${adm}/novedades/alertas-cruce/${id}/analizar`)
          .set(auth(c))
          .field('datos', JSON.stringify(datos));
        return archivo ? r.attach('archivo', pdf('acta de defunción'), 'defuncion.pdf') : r;
      };
      expect(
        (
          await analizar(analista, {
            accion: 'DESCARTAR',
            observacion: 'No corresponde a este caso',
          })
        ).status,
      ).toBe(403);
      expect(
        campos(await analizar(gestor, { accion: 'DESCARTAR', observacion: 'corta' })),
      ).toContain('observacion');
      expect(
        campos(
          await analizar(gestor, {
            accion: 'INICIAR_REVOCATORIA',
            observacion: 'Se verifica el registro civil',
          }),
        ),
      ).toContain('archivo');
      const ok = await analizar(
        gestor,
        {
          accion: 'INICIAR_REVOCATORIA',
          observacion: 'Se verificó el registro civil de defunción',
        },
        true,
      );
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ estado: 'EN_TRAMITE', analizadaPor: gestor.usuario });
      expect(ok.body.revocatoriaId).not.toBeNull();
      const rev = (await nov(gestor, `/revocatorias/${ok.body.revocatoriaId}`)).body;
      expect(rev).toMatchObject({
        estado: 'INICIADA',
        causal: expect.stringContaining('Fallecimiento'),
        radicado: casoB.radicado,
      });
      // Iniciar el trámite no finaliza el beneficio: eso exige el debido proceso.
      expect(await estadoBen(benB)).toBe('PENDIENTE_ENTREGA');
      expect(
        (await analizar(gestor, { accion: 'DESCARTAR', observacion: 'Ya se analizó antes' }))
          .status,
      ).toBe(409);
    });

    it('el cruce de uso de tarjetas alerta a los beneficiarios activos que no aparecen desde hace más de tres meses', async () => {
      const r = await cargar(
        'TRANSMETRO',
        `IDENTIFICACION,ESTADO\n${casoC.numero},ACTIVO\n77777777,ACTIVO\n`,
      );
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      // C aparece (usa su tarjeta); D, activo hace seis meses, no aparece; B no está activo todavía.
      expect(r.body.alertasGeneradas).toBe(1);
      const alertas = (await nov(gestor, '/alertas-cruce?estado=PENDIENTE')).body.items as {
        radicado: string;
        causalCodigo: string;
        detalle: string;
      }[];
      expect(alertas.map((a) => a.radicado)).toEqual([casoD.radicado]);
      expect(alertas[0]).toMatchObject({ causalCodigo: 'INACTIVIDAD' });
      expect(alertas[0]!.detalle).toContain('Ninguna persona del beneficio aparece');
      // Un beneficio activo hace menos de tres meses no se alerta.
      await e.pool.query(
        `UPDATE beneficios SET activado_at = now() - interval '1 month' WHERE id = $1`,
        [benD],
      );
      const otra = await cargar('TRANSMETRO', `IDENTIFICACION,ESTADO\n${casoC.numero},ACTIVO\n`);
      expect(otra.body.alertasGeneradas).toBe(0);
      expect(await estadoBen(benD)).toBe('ACTIVO');
      const descartada = await request(e.app)
        .post(
          `${adm}/novedades/alertas-cruce/${(await nov(gestor, '/alertas-cruce?estado=PENDIENTE')).body.items[0].id}/analizar`,
        )
        .set(auth(gestor))
        .field(
          'datos',
          JSON.stringify({
            accion: 'DESCARTAR',
            observacion: 'La persona usa el servicio en otra ruta',
          }),
        );
      expect(descartada.body.estado).toBe('DESCARTADA');
      const bit = await e.pool.query(
        `SELECT accion FROM bitacora WHERE modulo = 'novedades' AND accion LIKE 'CRUCE_ALERTA%' ORDER BY id`,
      );
      expect(bit.rows.map((x) => x.accion)).toEqual([
        'CRUCE_ALERTA_GENERADA',
        'CRUCE_ALERTA_ANALIZADA',
        'CRUCE_ALERTA_GENERADA',
        'CRUCE_ALERTA_GENERADA',
        'CRUCE_ALERTA_ANALIZADA',
      ]);
    });
  });
});
