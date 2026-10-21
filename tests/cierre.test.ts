import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auth, crearCuenta, crearEntorno, type CuentaPrueba, type Entorno } from './helpers.js';
import { ayudantesSolicitud, bearer, pdf } from './solicitudes.js';

const adm = '/api/v1/admin';
const pub = '/api/v1/publico';

describe('cierre de requisitos de las entregas 2 y 3', () => {
  let e: Entorno;
  let ay: ReturnType<typeof ayudantesSolicitud>;
  let validador: CuentaPrueba;
  let asignador: CuentaPrueba;
  let gestor: CuentaPrueba;
  let control: CuentaPrueba;
  type Caso = Awaited<ReturnType<typeof ay.validada>>;
  let casos: Caso[];
  let ben: number[];

  const idBen = async (c: Caso) =>
    Number(
      (
        await e.pool.query<{ id: string }>(`SELECT id FROM beneficios WHERE solicitud_id = $1`, [
          c.solicitudId,
        ])
      ).rows[0]!.id,
    );
  const campos = (r: request.Response) =>
    (r.body.error?.errores ?? []).map((x: { campo: string }) => x.campo);
  const multipart = (c: CuentaPrueba, ruta: string, datos: object, archivo = true) => {
    const r = request(e.app)
      .post(`${adm}${ruta}`)
      .set(auth(c))
      .field('datos', JSON.stringify(datos));
    return archivo ? r.attach('archivo', pdf('soporte'), 'soporte.pdf') : r;
  };
  const causal = async (catalogo: string, codigo: string) =>
    (
      await e.pool.query<{ id: number }>(
        `SELECT id FROM catalogo_items WHERE catalogo = $1 AND codigo = $2`,
        [catalogo, codigo],
      )
    ).rows[0]!.id;
  const hoy = () => new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    asignador = await crearCuenta(e, 'ASIGNADOR');
    gestor = await crearCuenta(e, 'GESTOR_NOVEDADES');
    control = await crearCuenta(e, 'CONTROL_INTERNO');
    await e.pool.query(
      `UPDATE vigencias SET cupos_totales = 10, valor_estimulo = 500000, presupuesto_total = 50000000 WHERE activa`,
    );
    casos = [
      await ay.validada(validador, {}, { correo: 'cierre.a@correo.com' }),
      await ay.validada(validador, {}, { correo: 'cierre.b@correo.com' }),
      await ay.validada(validador, {}, { correo: 'cierre.c@correo.com' }),
    ];
    const r = await request(e.app)
      .post(`${adm}/asignacion/asignar`)
      .set(auth(asignador))
      .send({ solicitudIds: casos.map((c) => c.solicitudId) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ben = [await idBen(casos[0]!), await idBen(casos[1]!), await idBen(casos[2]!)];
    await e.pool.query(
      `UPDATE beneficios SET estado = 'ACTIVO', activado_at = now() WHERE id = ANY($1::bigint[])`,
      [ben],
    );
  });
  afterAll(async () => {
    await e.cerrar();
  });

  describe('finalización del beneficio (RF-BEN-05)', () => {
    it('exige causal, justificación y soporte, y solo la registra el gestor', async () => {
      const base = { causalId: 1, fechaEfectiva: hoy(), observacion: 'Falleció el 10 de octubre.' };
      expect(
        (await multipart(control, `/novedades/beneficios/${ben[0]}/finalizar`, base)).status,
      ).toBe(403);
      expect(
        (await multipart(gestor, `/novedades/beneficios/${ben[0]}/finalizar`, base, false)).status,
      ).toBe(422);
      const sin = await multipart(gestor, `/novedades/beneficios/${ben[0]}/finalizar`, {
        ...base,
        observacion: 'corta',
        causalId: 999999,
      });
      expect(campos(sin)).toEqual(expect.arrayContaining(['observacion']));
      const causalMala = await multipart(gestor, `/novedades/beneficios/${ben[0]}/finalizar`, {
        ...base,
        causalId: 999999,
      });
      expect(campos(causalMala)).toContain('causalId');
    });

    it('finaliza, libera el cupo, avisa a la persona y deja el historial', async () => {
      const causalId = await causal('CAUSAL_FINALIZACION', 'FALLECIMIENTO');
      const antes = e.mailer.enviados.length;
      const r = await multipart(gestor, `/novedades/beneficios/${ben[0]}/finalizar`, {
        causalId,
        fechaEfectiva: hoy(),
        observacion: 'Falleció el 10 de octubre; se adjunta el registro civil de defunción.',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const estado = await e.pool.query(`SELECT estado, motivo_fin FROM beneficios WHERE id = $1`, [
        ben[0],
      ]);
      expect(estado.rows[0].estado).toBe('FINALIZADO');
      expect(estado.rows[0].motivo_fin).toContain('Fallecimiento');
      expect(r.body.novedades.at(-1)).toMatchObject({
        tipo: 'FINALIZACION',
        tipoNombre: 'Finalización del beneficio',
      });
      await e.servicios.correos.esperarDespachos();
      const correo = e.mailer.enviados.slice(antes).find((m) => m.subject.includes('Finalización'));
      expect(correo?.to).toBe('cierre.a@correo.com');
      expect(correo?.text).toContain('Fallecimiento');
      const alerta = await e.pool.query(
        `SELECT 1 FROM alertas WHERE tipo = 'CUPO_LIBERADO' AND beneficio_id = $1`,
        [ben[0]],
      );
      expect(alerta.rowCount).toBe(1);
      const otra = await multipart(gestor, `/novedades/beneficios/${ben[0]}/finalizar`, {
        causalId,
        fechaEfectiva: hoy(),
        observacion: 'Intento repetido de finalizar.',
      });
      expect(otra.status).toBe(409);
      expect(otra.body.error.codigo).toBe('BENEFICIO_FINALIZADO');
    });

    it('no finaliza por fuera de una revocatoria en curso', async () => {
      const causalRev = await causal('CAUSAL_REVOCATORIA', 'USO_INDEBIDO');
      const rev = await multipart(gestor, `/novedades/beneficios/${ben[2]}/revocatorias`, {
        causalId: causalRev,
        descripcion: 'Se reportó el uso de la tarjeta por otra persona.',
      });
      expect(rev.status, JSON.stringify(rev.body)).toBe(201);
      const r = await multipart(gestor, `/novedades/beneficios/${ben[2]}/finalizar`, {
        causalId: await causal('CAUSAL_FINALIZACION', 'RENUNCIA'),
        fechaEfectiva: hoy(),
        observacion: 'Renuncia voluntaria de la persona.',
      });
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('REVOCATORIA_ABIERTA');
    });
  });

  describe('actualización de datos (RF-BEN-05)', () => {
    it('cambia la dirección con soporte y conserva el valor anterior', async () => {
      const loc = (
        await e.pool.query<{ id: number; b: number }>(
          `SELECT l.id, (SELECT b.id FROM catalogo_items b WHERE b.padre_id = l.id AND b.catalogo = 'BARRIO' LIMIT 1) AS b
             FROM catalogo_items l WHERE l.catalogo = 'LOCALIDAD' AND EXISTS (SELECT 1 FROM catalogo_items b WHERE b.padre_id = l.id) LIMIT 1`,
        )
      ).rows[0]!;
      const mala = await multipart(gestor, `/novedades/beneficios/${ben[1]}/datos`, {
        dato: 'DIRECCION',
        justificacion: 'Se mudó de domicilio.',
        direccion: 'por ahí',
        localidadId: loc.id,
        barrioId: loc.b,
      });
      expect(campos(mala)).toContain('direccion');
      const r = await multipart(gestor, `/novedades/beneficios/${ben[1]}/datos`, {
        dato: 'DIRECCION',
        justificacion: 'Se mudó de domicilio; se adjunta el recibo.',
        direccion: 'Calle 45 # 20 - 30',
        localidadId: loc.id,
        barrioId: loc.b,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.actualizaciones).toHaveLength(1);
      expect(r.body.actualizaciones[0]).toMatchObject({ dato: 'DIRECCION' });
      const s = await e.pool.query(
        `SELECT direccion, localidad_id FROM solicitudes WHERE id = $1`,
        [casos[1]!.solicitudId],
      );
      expect(s.rows[0]).toMatchObject({ direccion: 'Calle 45 # 20 - 30', localidad_id: loc.id });
      const b = await e.pool.query(
        `SELECT valor_anterior, valor_nuevo FROM bitacora WHERE accion = 'DATOS_ACTUALIZADOS' ORDER BY id DESC LIMIT 1`,
      );
      expect(b.rows[0].valor_nuevo.dato).toBe('DIRECCION');
    });

    it('cambia el correo, valida que sea otro y lo deja registrado', async () => {
      const igual = await multipart(gestor, `/novedades/beneficios/${ben[1]}/datos`, {
        dato: 'CORREO',
        justificacion: 'La persona cambió de correo.',
        correo: 'cierre.b@correo.com',
      });
      expect(campos(igual)).toContain('correo');
      const r = await multipart(gestor, `/novedades/beneficios/${ben[1]}/datos`, {
        dato: 'CORREO',
        justificacion: 'La persona cambió de correo electrónico.',
        correo: 'Nuevo.B@correo.com',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(
        (
          await e.pool.query(`SELECT correo FROM solicitudes WHERE id = $1`, [
            casos[1]!.solicitudId,
          ])
        ).rows[0].correo,
      ).toBe('nuevo.b@correo.com');
    });

    it('cambia el cuidador respetando que una persona solo recibe un beneficio y pide la nueva tarjeta', async () => {
      const tipo = (
        await e.pool.query<{ id: number }>(
          `SELECT id FROM catalogo_items WHERE catalogo = 'TIPO_IDENTIFICACION' AND codigo = 'CC'`,
        )
      ).rows[0]!.id;
      const cuidadorDeC = (
        await e.pool.query<{ numero: string }>(
          `SELECT p.numero_identificacion AS numero FROM solicitudes s JOIN personas p ON p.id = s.cuidador_id WHERE s.id = $1`,
          [casos[2]!.solicitudId],
        )
      ).rows[0]!.numero;
      const ocupado = await multipart(gestor, `/novedades/beneficios/${ben[1]}/datos`, {
        dato: 'CUIDADOR',
        justificacion: 'Cambió la persona que cuida.',
        tipoIdentificacionId: tipo,
        numeroIdentificacion: cuidadorDeC,
        nombre: 'Persona Ocupada',
      });
      expect(ocupado.status).toBe(409);
      expect(ocupado.body.error.codigo).toBe('CUIDADOR_CON_BENEFICIO');
      const r = await multipart(gestor, `/novedades/beneficios/${ben[1]}/datos`, {
        dato: 'CUIDADOR',
        justificacion: 'Cambió la persona que cuida.',
        tipoIdentificacionId: tipo,
        numeroIdentificacion: '9988776655',
        nombre: 'Rosa Elena Martínez',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const nuevo = await e.pool.query(
        `SELECT p.nombre_completo FROM solicitudes s JOIN personas p ON p.id = s.cuidador_id WHERE s.id = $1`,
        [casos[1]!.solicitudId],
      );
      expect(nuevo.rows[0].nombre_completo).toBe('Rosa Elena Martínez');
      const vig = await e.pool.query(
        `SELECT 1 FROM entregas WHERE beneficio_id = $1 AND rol = 'CUIDADOR' AND vigente`,
        [ben[1]],
      );
      expect(vig.rowCount).toBe(0);
      // La nueva tarjeta se entrega aunque el beneficio ya esté activo.
      const detalle = await request(e.app)
        .get(`${adm}/asignacion/beneficiarios/${ben[1]}`)
        .set(auth(asignador));
      expect(detalle.status, JSON.stringify(detalle.body)).toBe(200);
      expect(detalle.body.pendientes).toContain('CUIDADOR');
    });

    it('lo hace solo el gestor y nunca sobre un beneficio finalizado', async () => {
      const r = await multipart(control, `/novedades/beneficios/${ben[1]}/datos`, {
        dato: 'CORREO',
        justificacion: 'Cambio de correo electrónico.',
        correo: 'otro@correo.com',
      });
      expect(r.status).toBe(403);
      const fin = await multipart(gestor, `/novedades/beneficios/${ben[0]}/datos`, {
        dato: 'CORREO',
        justificacion: 'Cambio de correo electrónico.',
        correo: 'otro@correo.com',
      });
      expect(fin.status).toBe(409);
    });
  });

  describe('plazos de la subsanación (RF-VER-05, RN-12)', () => {
    async function pedirSubsanacion() {
      const s = await ay.solicitudRadicada({ correo: 'plazo@correo.com' });
      const h = auth(validador);
      const v = `${adm}/validacion`;
      const tomada = await request(e.app).post(`${v}/casos/${s.solicitudId}/tomar`).set(h).send();
      const items = tomada.body.items as { id: number; codigo: string }[];
      for (const i of items) {
        const nc = i.codigo === 'PCD_SISBEN';
        const m = await request(e.app)
          .put(`${v}/casos/${s.solicitudId}/items/${i.id}`)
          .set(h)
          .send({
            resultado: nc ? 'NO_CUMPLE' : 'CUMPLE',
            fuente: nc ? '' : 'Consulta realizada',
            observacion: nc ? 'El soporte no está vigente.' : '',
            evidencia: '',
          });
        expect(m.status, JSON.stringify(m.body)).toBe(200);
      }
      const d = await request(e.app)
        .post(`${v}/casos/${s.solicitudId}/decision`)
        .set(h)
        .send({ decision: 'SUBSANAR', motivacion: 'El soporte del SISBÉN no está vigente.' });
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      await e.servicios.correos.esperarDespachos();
      return s;
    }
    const estado = async (id: number) =>
      (await e.pool.query<{ estado: string }>(`SELECT estado FROM solicitudes WHERE id = $1`, [id]))
        .rows[0]!.estado;

    it('avisa una sola vez antes de vencer y no antes de tiempo', async () => {
      const s = await pedirSubsanacion();
      expect(await e.servicios.subsanacion.revisarPlazos()).toEqual({
        recordatorios: 0,
        vencidas: 0,
      });
      await e.pool.query(
        `UPDATE subsanaciones SET vence_at = now() + interval '1 day' WHERE solicitud_id = $1`,
        [s.solicitudId],
      );
      e.mailer.enviados.length = 0;
      expect(await e.servicios.subsanacion.revisarPlazos()).toEqual({
        recordatorios: 1,
        vencidas: 0,
      });
      await e.servicios.correos.esperarDespachos();
      const correo = e.mailer.enviados.find((m) => m.subject.includes('Recordatorio'));
      expect(correo?.to).toBe('plazo@correo.com');
      expect(correo?.text).toContain('SISBÉN');
      expect(correo?.text).toMatch(/caracterizacion\?token=/);
      expect(await e.servicios.subsanacion.revisarPlazos()).toEqual({
        recordatorios: 0,
        vencidas: 0,
      });
      expect(await estado(s.solicitudId)).toBe('EN_SUBSANACION');
    });

    it('vencido el plazo pasa a «no cumple por vencimiento de término» y se notifica', async () => {
      const s = await pedirSubsanacion();
      await e.pool.query(
        `UPDATE subsanaciones SET vence_at = now() - interval '1 hour' WHERE solicitud_id = $1`,
        [s.solicitudId],
      );
      e.mailer.enviados.length = 0;
      const r = await e.servicios.subsanacion.revisarPlazos();
      expect(r.vencidas).toBe(1);
      expect(await estado(s.solicitudId)).toBe('NO_CUMPLE');
      await e.servicios.correos.esperarDespachos();
      const correo = e.mailer.enviados.find((m) => m.subject.includes('Venció el plazo'));
      expect(correo?.text).toContain('no cumple por vencimiento de término');
      const b = await e.pool.query(
        `SELECT justificacion, usuario_id FROM bitacora WHERE accion = 'SUBSANACION_VENCIDA' AND solicitud_id = $1`,
        [s.solicitudId],
      );
      expect(b.rows[0].usuario_id).toBeNull();
      expect(b.rows[0].justificacion).toContain('vencimiento de término');
      expect((await e.servicios.subsanacion.revisarPlazos()).vencidas).toBe(0);
    });
  });

  describe('descargos desde el portal ciudadano (RF-BEN-04)', () => {
    let revId: number;
    const cuenta = () => bearer(casos[2]!.token);

    it('la persona ve el traslado y presenta sus descargos dentro del plazo', async () => {
      const rev = (
        await e.pool.query<{ id: string }>(`SELECT id FROM revocatorias WHERE beneficio_id = $1`, [
          ben[2],
        ])
      ).rows[0]!;
      revId = Number(rev.id);
      // Todavía no hay traslado: no puede presentar descargos.
      const antes = await request(e.app).get(`${pub}/consulta/revocatoria`).set(cuenta());
      expect(antes.body.revocatoria).toMatchObject({
        estado: 'INICIADA',
        puedePresentarDescargos: false,
      });
      const prematuro = await request(e.app)
        .post(`${pub}/consulta/descargos`)
        .set(cuenta())
        .field('texto', 'Yo no presté la tarjeta a nadie.');
      expect(prematuro.status).toBe(409);
      const t = await multipart(gestor, `/novedades/revocatorias/${revId}/traslado`, {
        texto: 'El reporte indica que la tarjeta la usó una persona distinta al beneficiario.',
      });
      expect(t.status, JSON.stringify(t.body)).toBe(200);
      const ve = await request(e.app).get(`${pub}/consulta/revocatoria`).set(cuenta());
      expect(ve.body.revocatoria).toMatchObject({
        causal: expect.stringContaining('Uso indebido'),
        estado: 'EN_TRASLADO',
        puedePresentarDescargos: true,
        razones: expect.stringContaining('persona distinta'),
      });
      const corto = await request(e.app)
        .post(`${pub}/consulta/descargos`)
        .set(cuenta())
        .field('texto', 'no');
      expect(corto.status).toBe(422);
      const ok = await request(e.app)
        .post(`${pub}/consulta/descargos`)
        .set(cuenta())
        .field('texto', 'Yo no presté la tarjeta; fue un familiar autorizado como cuidador.')
        .attach('archivo', pdf('prueba'), 'prueba.pdf');
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      const detalle = await request(e.app)
        .get(`${adm}/novedades/revocatorias/${revId}`)
        .set(auth(gestor));
      expect(detalle.body.estado).toBe('CON_DESCARGOS');
      const ev = detalle.body.eventos.find((x: { etapa: string }) => x.etapa === 'DESCARGOS');
      expect(ev.usuario).toBe('Persona beneficiaria');
      expect(ev.evidencia.nombre).toBe('prueba.pdf');
      const log = await e.pool.query(
        `SELECT usuario_id FROM bitacora WHERE accion = 'DESCARGOS_CIUDADANO'`,
      );
      expect(log.rowCount).toBe(1);
    });

    it('no se presentan descargos dos veces ni sin sesión', async () => {
      const otra = await request(e.app)
        .post(`${pub}/consulta/descargos`)
        .set(cuenta())
        .field('texto', 'Otro descargo adicional sobre el mismo trámite.');
      expect(otra.status).toBe(409);
      const sin = await request(e.app)
        .post(`${pub}/consulta/descargos`)
        .field('texto', 'Sin sesión de acceso.');
      expect(sin.status).toBe(401);
    });
  });

  describe('comunicaciones rebotadas (RF-COM-03)', () => {
    it('el expediente muestra el contenido, la alerta de rebote y permite reenviar tras corregir el correo', async () => {
      const s = casos[2]!;
      const rebotado = (
        await e.pool.query<{ id: string }>(
          `UPDATE correos SET estado = 'REBOTADO', rebote_motivo = 'Buzón inexistente'
            WHERE id = (SELECT id FROM correos WHERE solicitud_id = $1 AND secretos IS NULL ORDER BY id LIMIT 1)
            RETURNING id`,
          [s.solicitudId],
        )
      ).rows[0]!;
      const exp = await request(e.app)
        .get(`${adm}/expedientes/${s.solicitudId}`)
        .set(auth(control));
      expect(exp.status).toBe(200);
      expect(exp.body.alertaRebote).toBe(true);
      const c = exp.body.comunicaciones.find((x: { id: number }) => x.id === Number(rebotado.id));
      expect(c).toMatchObject({
        estado: 'REBOTADO',
        reboteMotivo: 'Buzón inexistente',
        reenviado: false,
      });
      expect(c.cuerpo.length).toBeGreaterThan(20);
      expect(c.destinatario).toMatch(/\*/);
      expect(exp.body.decisiones.length).toBeGreaterThan(0);
      expect(exp.body.decisiones[0].listaDeChequeo.length).toBeGreaterThan(0);

      // Reenviar a la misma dirección no tiene sentido: primero se corrige el correo.
      const igual = await request(e.app)
        .post(`${adm}/expedientes/${s.solicitudId}/comunicaciones/${rebotado.id}/reenviar`)
        .set(auth(gestor));
      expect(igual.status).toBe(409);
      expect(igual.body.error.codigo).toBe('CORREO_SIN_CAMBIOS');

      const sinSoporte = await request(e.app)
        .post(`${adm}/expedientes/${s.solicitudId}/correo`)
        .set(auth(gestor))
        .field(
          'datos',
          JSON.stringify({
            correo: 'corregido@correo.com',
            justificacion: 'La persona lo corrigió.',
          }),
        );
      expect(sinSoporte.status).toBe(422);
      e.mailer.enviados.length = 0;
      const r = await multipart(gestor, `/expedientes/${s.solicitudId}/correo`, {
        correo: 'corregido@correo.com',
        justificacion: 'La persona confirmó por teléfono su correo correcto.',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.reenviados).toBe(1);
      await e.servicios.correos.esperarDespachos();
      expect(e.mailer.enviados).toHaveLength(1);
      expect(e.mailer.enviados[0]?.to).toBe('corregido@correo.com');

      const despues = await request(e.app)
        .get(`${adm}/expedientes/${s.solicitudId}`)
        .set(auth(control));
      expect(despues.status).toBe(200);
      expect(despues.body.alertaRebote).toBe(false);
      const original = despues.body.comunicaciones.find(
        (x: { id: number }) => x.id === Number(rebotado.id),
      );
      expect(original.reenviado).toBe(true);
      const copia = despues.body.comunicaciones.find(
        (x: { reenvioDe: number | null }) => x.reenvioDe === Number(rebotado.id),
      );
      expect(copia.cuerpo).toBe(original.cuerpo);
    });

    it('solo el gestor corrige el correo', async () => {
      const r = await multipart(control, `/expedientes/${casos[2]!.solicitudId}/correo`, {
        correo: 'x@correo.com',
        justificacion: 'Intento sin permiso de gestión.',
      });
      expect(r.status).toBe(403);
    });
  });

  describe('bitácora exportable (RNF-07) y tablero ampliado', () => {
    it('exporta la bitácora filtrada a Excel y PDF y deja registro', async () => {
      const bin = (formato: string) =>
        request(e.app)
          .get(`${adm}/bitacora/exportar?formato=${formato}&modulo=novedades`)
          .set(auth(control))
          .buffer(true)
          .parse((res, cb) => {
            const t: Buffer[] = [];
            res.on('data', (x: Buffer) => t.push(x));
            res.on('end', () => cb(null, Buffer.concat(t)));
          });
      const x = await bin('XLSX');
      expect(x.status).toBe(200);
      expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
      const p = await bin('PDF');
      expect((p.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
      expect((await bin('DOC')).status).toBe(422);
      const reg = await e.pool.query(
        `SELECT filtros FROM exportaciones WHERE reporte = 'BITACORA'`,
      );
      expect(reg.rowCount).toBe(2);
      expect(reg.rows[0].filtros.modulo).toBe('novedades');
      expect(
        (await request(e.app).get(`${adm}/bitacora/exportar?formato=XLSX`).set(auth(validador)))
          .status,
      ).toBe(403);
    });

    it('el tablero incluye en verificación, por subsanar y la ejecución de cupos', async () => {
      const r = await request(e.app).get(`${adm}/tablero`).set(auth(control));
      expect(r.body.embudo).toHaveProperty('enVerificacion');
      expect(r.body.embudo).toHaveProperty('porSubsanar');
      expect(r.body.presupuesto).toMatchObject({ cupos: 10 });
      expect(r.body.presupuesto.cuposUsados).toBeGreaterThanOrEqual(1);
      expect(r.body.presupuesto.cuposEjecucion).toBeGreaterThan(0);
    });
  });
});
