import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  asignarEnBd,
  auth,
  crearCuenta,
  crearEntorno,
  type CuentaPrueba,
  type Entorno,
} from './helpers.js';
import { ayudantesSolicitud, bearer, pdf } from './solicitudes.js';

const adm = '/api/v1/admin';
const pub = '/api/v1/publico';

interface ItemCaso {
  id: number;
  codigo: string;
  nombre: string;
  resultado: string;
  documentoId: number | null;
  campos: string[];
  subsanable: boolean;
}
interface Caso {
  solicitud: { id: number; estado: { codigo: string }; superaTiempo: boolean; dias: number };
  validacion: { puedeEditar: boolean; enRevisionPor: string | null; asignadoA: string | null };
  items: ItemCaso[];
  datos: Record<string, unknown>;
  sensiblesOcultos: boolean;
  documentos: { id: number; puedeVer: boolean; archivo: unknown }[];
  decisiones: { decision: string; motivacion: string }[];
  subsanacion: { estado: string; items: { nombre: string }[] } | null;
}

describe('validación de requisitos (RF-VAL-01, RF-VAL-02, RF-VAL-05) y subsanación (RF-CAR-06)', () => {
  let e: Entorno;
  let validador: CuentaPrueba;
  let otroValidador: CuentaPrueba;
  let responsable: CuentaPrueba;
  let analista: CuentaPrueba;
  let administrador: CuentaPrueba;
  let sinSensibles: CuentaPrueba;
  let ay: ReturnType<typeof ayudantesSolicitud>;

  beforeAll(async () => {
    e = await crearEntorno();
    ay = ayudantesSolicitud(e);
    validador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    otroValidador = await crearCuenta(e, 'AUDITOR_VERIFICADOR');
    responsable = await crearCuenta(e, 'RESPONSABLE_PROCESO');
    analista = await crearCuenta(e, 'ANALISTA');
    administrador = await crearCuenta(e, 'ADMINISTRADOR');
    // Un rol propio que ve los casos pero no los datos sensibles.
    await e.pool.query(
      `INSERT INTO roles (codigo, nombre, descripcion, sistema) VALUES ('SOLO_VER', 'Solo ver', 'Ve los casos', false)`,
    );
    await e.pool.query(
      `INSERT INTO rol_permiso (rol_id, permiso_codigo) SELECT id, 'validacion.ver' FROM roles WHERE codigo = 'SOLO_VER'`,
    );
    sinSensibles = await crearCuenta(e, 'SOLO_VER');
  });
  afterAll(async () => {
    await e.cerrar();
  });
  beforeEach(async () => {
    await e.servicios.correos.esperarDespachos();
    e.mailer.enviados.length = 0;
  });

  const get = (c: CuentaPrueba, ruta: string) =>
    request(e.app).get(`${adm}/validacion${ruta}`).set(auth(c));
  const post = (c: CuentaPrueba, ruta: string, cuerpo: object = {}) =>
    request(e.app).post(`${adm}/validacion${ruta}`).set(auth(c)).send(cuerpo);
  const put = (c: CuentaPrueba, ruta: string, cuerpo: object) =>
    request(e.app).put(`${adm}/validacion${ruta}`).set(auth(c)).send(cuerpo);

  const caso = async (c: CuentaPrueba, id: number) => (await get(c, `/casos/${id}`)).body as Caso;
  const tomar = async (c: CuentaPrueba, id: number) => {
    await asignarEnBd(e, id, c.id);
    const r = await post(c, `/casos/${id}/tomar`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as Caso;
  };
  const marcar = async (
    c: CuentaPrueba,
    id: number,
    item: ItemCaso,
    resultado: string,
    extra: Partial<{ fuente: string; observacion: string; evidencia: string }> = {},
  ) => {
    const r = await put(c, `/casos/${id}/items/${item.id}`, {
      resultado,
      fuente: resultado === 'CUMPLE' ? 'Consulta realizada' : '',
      observacion: '',
      evidencia: '',
      ...extra,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  };
  /** Registra los datos de priorización que pide la matriz vigente (la primera opción de cada uno). */
  const capturarVariables = async (c: CuentaPrueba, id: number) => {
    const { priorizacion } = (await caso(c, id)) as unknown as {
      priorizacion: { variables: { codigo: string; opciones: { codigo: string }[] }[] };
    };
    for (const v of priorizacion.variables) {
      const r = await put(c, `/casos/${id}/variables/${v.codigo}`, {
        valor: v.opciones[0]!.codigo,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  };
  /** Marca todos los requisitos como cumplidos y registra los datos de priorización. */
  const cumplirTodo = async (c: CuentaPrueba, id: number) => {
    for (const item of (await caso(c, id)).items) await marcar(c, id, item, 'CUMPLE');
    await capturarVariables(c, id);
  };
  const estadoDe = async (id: number) =>
    (await e.pool.query<{ estado: string }>(`SELECT estado FROM solicitudes WHERE id = $1`, [id]))
      .rows[0]!.estado;
  const ultimoCorreo = async () => {
    await e.servicios.correos.esperarDespachos();
    return e.mailer.ultimo();
  };

  describe('permisos por rol (RF-SEG-02)', () => {
    it('sin sesión no hay acceso y cada rol solo hace lo suyo, también por la API', async () => {
      expect((await request(e.app).get(`${adm}/validacion/bandeja`)).status).toBe(401);
      expect((await get(analista, '/bandeja')).status).toBe(403);
      expect((await get(validador, '/bandeja')).status).toBe(200);
      expect((await get(responsable, '/bandeja')).status).toBe(200);
      // Un validador no asigna; el responsable del proceso no valida.
      expect(
        (await post(validador, '/asignar', { solicitudIds: [1], validadorId: null })).status,
      ).toBe(403);
      expect((await get(validador, '/validadores')).status).toBe(403);
      const s = await ay.solicitudRadicada();
      expect((await post(responsable, `/casos/${s.solicitudId}/tomar`)).status).toBe(403);
      expect(
        (await put(responsable, `/casos/${s.solicitudId}/items/1`, { resultado: 'CUMPLE' })).status,
      ).toBe(403);
      expect(
        (await post(responsable, `/casos/${s.solicitudId}/decision`, { decision: 'APROBAR' }))
          .status,
      ).toBe(403);
    });
  });

  describe('bandeja de trabajo (RF-VAL-01)', () => {
    it('muestra radicado, fecha, nombre, estado y días transcurridos, y permite filtrar y ordenar', async () => {
      const a = await ay.solicitudRadicada({ nombre: 'Zulema Torres' });
      const b = await ay.solicitudRadicada({ nombre: 'Ana Beltrán' });
      const r = await get(responsable, '/bandeja?tamano=100');
      expect(r.status).toBe(200);
      const fila = r.body.items.find((x: { radicado: string }) => x.radicado === a.radicado);
      expect(fila).toMatchObject({
        pcdNombre: 'Zulema Torres',
        estado: { codigo: 'RADICADA' },
        dias: 0,
        superaTiempo: false,
        asignadoA: null,
        enRevisionPor: null,
        subsanado: false,
      });
      expect(fila.radicadaAt).toBeTruthy();
      const buscado = await get(responsable, `/bandeja?q=${encodeURIComponent('beltr')}`);
      expect(buscado.body.items.map((x: { radicado: string }) => x.radicado)).toEqual([b.radicado]);
      const porNombre = await get(responsable, '/bandeja?orden=nombre&direccion=asc&tamano=100');
      const nombres = porNombre.body.items.map((x: { pcdNombre: string }) =>
        x.pcdNombre.toLowerCase(),
      );
      expect(nombres).toEqual([...nombres].sort());
      const porRadicado = await get(responsable, '/bandeja?q=' + a.radicado);
      expect(porRadicado.body.total).toBe(1);
    });

    it('resalta los casos que superan el tiempo máximo de atención configurado', async () => {
      const s = await ay.solicitudRadicada();
      await e.pool.query(
        `UPDATE solicitudes SET radicada_at = now() - interval '9 days' WHERE id = $1`,
        [s.solicitudId],
      );
      const r = await get(responsable, `/bandeja?q=${s.radicado}`);
      expect(r.body.tiempoMaxDias).toBe(5);
      expect(r.body.items[0]).toMatchObject({ dias: 9, superaTiempo: true });
      const soloVencidas = await get(responsable, '/bandeja?vencidas=true&tamano=100');
      expect(soloVencidas.body.items.map((x: { radicado: string }) => x.radicado)).toContain(
        s.radicado,
      );
      expect((await caso(validador, s.solicitudId)).solicitud.superaTiempo).toBe(true);
    });

    it('el responsable del proceso asigna y reasigna casos entre validadores', async () => {
      const s = await ay.solicitudRadicada();
      const lista = await get(responsable, '/validadores');
      expect(lista.body.items.map((x: { id: number }) => x.id)).toEqual(
        expect.arrayContaining([validador.id, otroValidador.id]),
      );
      // Solo se asigna a quien puede validar.
      expect(
        (
          await post(responsable, '/asignar', {
            solicitudIds: [s.solicitudId],
            validadorId: analista.id,
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await post(responsable, '/asignar', {
            solicitudIds: [s.solicitudId],
            validadorId: validador.id,
          })
        ).status,
      ).toBe(200);
      const mios = await get(validador, '/bandeja?asignado=mios&tamano=100');
      expect(mios.body.items.map((x: { radicado: string }) => x.radicado)).toContain(s.radicado);
      const sin = await get(responsable, '/bandeja?asignado=sin&tamano=100');
      expect(sin.body.items.map((x: { radicado: string }) => x.radicado)).not.toContain(s.radicado);
      // Otro validador no puede tomar un caso asignado a alguien más.
      const r = await post(otroValidador, `/casos/${s.solicitudId}/tomar`);
      expect(r.status).toBe(409);
      expect(r.body.error.codigo).toBe('CASO_ASIGNADO');
      // Reasignar: ahora es del otro.
      await post(responsable, '/asignar', {
        solicitudIds: [s.solicitudId],
        validadorId: otroValidador.id,
      });
      expect((await post(validador, `/casos/${s.solicitudId}/tomar`)).status).toBe(409);
      expect((await post(otroValidador, `/casos/${s.solicitudId}/tomar`)).status).toBe(200);
      const b = await e.pool.query(
        `SELECT accion FROM bitacora WHERE solicitud_id = $1 AND accion = 'VALIDACION_ASIGNADA'`,
        [s.solicitudId],
      );
      expect(b.rowCount).toBe(2);
    });
  });

  describe('reparto de casos y avisos', () => {
    it('el validador solo ve sus casos, el administrador no entra en el reparto y cada quien recibe su aviso', async () => {
      const s = await ay.solicitudRadicada({ nombre: 'Aviso Reparto' });
      const alertasDe = async (c: CuentaPrueba) =>
        (await request(e.app).get(`${adm}/alertas`).set(auth(c))).body.items as {
          tipo: string;
          titulo: string;
          solicitudId: number | null;
        }[];
      // Al radicarse, el aviso llega a quien asigna, no a quien valida.
      expect(
        (await alertasDe(responsable)).some(
          (a) => a.tipo === 'CASO_RADICADO' && a.solicitudId === s.solicitudId,
        ),
      ).toBe(true);
      expect((await alertasDe(validador)).some((a) => a.solicitudId === s.solicitudId)).toBe(false);
      // Sin asignar, el validador no ve el caso en su bandeja.
      const antes = await get(validador, '/bandeja?tamano=100');
      expect(antes.body.items.map((x: { radicado: string }) => x.radicado)).not.toContain(
        s.radicado,
      );
      // El administrador no es un validador al que se pueda asignar.
      const lista = await get(responsable, '/validadores');
      expect(lista.body.items.map((u: { id: number }) => u.id)).not.toContain(administrador.id);
      expect(
        (
          await post(responsable, '/asignar', {
            solicitudIds: [s.solicitudId],
            validadorId: administrador.id,
          })
        ).status,
      ).toBe(422);
      // Al asignar, el aviso es solo del validador elegido.
      await post(responsable, '/asignar', {
        solicitudIds: [s.solicitudId],
        validadorId: validador.id,
      });
      const suyas = await alertasDe(validador);
      expect(
        suyas.some((a) => a.tipo === 'CASOS_ASIGNADOS' && a.solicitudId === s.solicitudId),
      ).toBe(true);
      expect((await alertasDe(otroValidador)).some((a) => a.solicitudId === s.solicitudId)).toBe(
        false,
      );
      const despues = await get(validador, '/bandeja?tamano=100');
      expect(despues.body.items.map((x: { radicado: string }) => x.radicado)).toContain(s.radicado);
      // El administrador no puede tomarlo: no es suyo.
      expect((await post(administrador, `/casos/${s.solicitudId}/tomar`)).status).toBe(409);
    });
  });

  describe('revisión de un caso', () => {
    it('al abrir el caso queda «en revisión» y nadie más puede trabajarlo al mismo tiempo', async () => {
      const s = await ay.solicitudRadicada();
      const abierto = await tomar(validador, s.solicitudId);
      expect(abierto.solicitud.estado.codigo).toBe('EN_REVISION');
      expect(abierto.validacion).toMatchObject({
        puedeEditar: true,
        enRevisionPor: expect.any(String),
      });
      const otro = await post(otroValidador, `/casos/${s.solicitudId}/tomar`);
      expect(otro.status).toBe(409);
      expect(otro.body.error.codigo).toBe('CASO_EN_REVISION');
      // El otro puede mirarlo, pero no editar ni decidir.
      const mirada = await caso(otroValidador, s.solicitudId);
      expect(mirada.validacion.puedeEditar).toBe(false);
      const item = abierto.items[0]!;
      const edicion = await put(otroValidador, `/casos/${s.solicitudId}/items/${item.id}`, {
        resultado: 'CUMPLE',
        fuente: 'x',
      });
      expect(edicion.status).toBe(409);
      expect(
        (await post(otroValidador, `/casos/${s.solicitudId}/decision`, { decision: 'APROBAR' }))
          .status,
      ).toBe(409);
      // En la bandeja se ve quién lo tiene.
      const fila = (await get(responsable, `/bandeja?q=${s.radicado}`)).body.items[0];
      expect(fila.estado.codigo).toBe('EN_REVISION');
      expect(fila.enRevisionPor.id).toBe(validador.id);
      // Al devolverlo a la bandeja queda libre otra vez.
      expect((await post(validador, `/casos/${s.solicitudId}/liberar`)).status).toBe(204);
      expect(await estadoDe(s.solicitudId)).toBe('RADICADA');
      // Devolverlo también quita la asignación: nadie lo puede tomar hasta que el responsable lo asigne de nuevo.
      const sinAsignar = await post(otroValidador, `/casos/${s.solicitudId}/tomar`);
      expect(sinAsignar.status).toBe(409);
      expect(sinAsignar.body.error.codigo).toBe('CASO_ASIGNADO');
      expect(
        (await get(responsable, `/bandeja?asignado=sin&tamano=100`)).body.items.map(
          (x: { radicado: string }) => x.radicado,
        ),
      ).toContain(s.radicado);
      expect((await post(validador, `/casos/${s.solicitudId}/tomar`)).status).toBe(409);
      await post(responsable, '/asignar', {
        solicitudIds: [s.solicitudId],
        validadorId: otroValidador.id,
      });
      expect((await post(otroValidador, `/casos/${s.solicitudId}/tomar`)).status).toBe(200);
    });

    it('la lista de chequeo trae los requisitos que corresponden y cada resultado deja versión e historial', async () => {
      const s = await ay.solicitudRadicada({ cuidador: false });
      const sin = await tomar(validador, s.solicitudId);
      expect(sin.items.some((i) => i.codigo.startsWith('CUI_'))).toBe(false);
      expect(sin.items.map((i) => i.codigo)).toEqual(
        expect.arrayContaining(['PCD_IDENTIDAD', 'PCD_SISBEN', 'COM_CARTA_SOLICITUD']),
      );
      expect(sin.items.every((i) => i.resultado === 'PENDIENTE')).toBe(true);
      const con = await ay.solicitudRadicada({ cuidador: true });
      const conCuidador = await tomar(otroValidador, con.solicitudId);
      expect(conCuidador.items.some((i) => i.codigo === 'CUI_CUIDADO')).toBe(true);
      const item = sin.items[0]!;
      await marcar(validador, s.solicitudId, item, 'CUMPLE', {
        observacion: 'Todo bien',
        evidencia: 'Captura SISBÉN',
      });
      await marcar(validador, s.solicitudId, item, 'NO_CUMPLE', { observacion: 'Ilegible' });
      const actual = (await caso(validador, s.solicitudId)).items.find((i) => i.id === item.id)!;
      expect(actual.resultado).toBe('NO_CUMPLE');
      const h = await e.pool.query(
        `SELECT version FROM historial_versiones WHERE tabla = 'validacion_items' AND registro_id = $1 ORDER BY version`,
        [item.id],
      );
      expect(h.rows.map((x) => x.version)).toEqual([1, 2, 3]);
      const malo = await put(validador, `/casos/${s.solicitudId}/items/${item.id}`, {
        resultado: 'TAL_VEZ',
      });
      expect(malo.status).toBe(422);
    });

    it('los datos sensibles solo los ve quien tiene permiso; los demás los ven ocultos y no abren documentos', async () => {
      const s = await ay.solicitudRadicada();
      const completo = await caso(validador, s.solicitudId);
      expect(completo.sensiblesOcultos).toBe(false);
      expect(completo.datos['epsId']).not.toBeNull();
      expect(completo.documentos.some((d) => d.puedeVer)).toBe(true);
      const oculto = await caso(sinSensibles, s.solicitudId);
      expect(oculto.sensiblesOcultos).toBe(true);
      expect(oculto.datos['epsId']).toBeNull();
      expect(oculto.datos['embarazo']).toBeNull();
      expect(oculto.datos['celular']).toBe('3001234567');
      expect(oculto.documentos.every((d) => !d.puedeVer)).toBe(true);
      const doc = completo.documentos.find((d) => d.archivo)!;
      expect(
        (await get(sinSensibles, `/casos/${s.solicitudId}/documentos/${doc.id}/archivo`)).status,
      ).toBe(403);
      const ok = await get(validador, `/casos/${s.solicitudId}/documentos/${doc.id}/archivo`);
      expect(ok.status).toBe(200);
      expect(ok.headers['content-disposition']).toContain('attachment');
      const b = await e.pool.query(
        `SELECT usuario_id FROM bitacora WHERE solicitud_id = $1 AND accion = 'VALIDACION_DOCUMENTO_CONSULTADO'`,
        [s.solicitudId],
      );
      expect(b.rows.map((x) => x.usuario_id)).toEqual([validador.id]);
    });
  });

  describe('decisión motivada (RF-VAL-02) y notificación (RF-VAL-05)', () => {
    it('no deja aprobar con requisitos «no cumple» o «pendientes», ni rechazar sin motivación', async () => {
      const s = await ay.solicitudRadicada();
      const c = await tomar(validador, s.solicitudId);
      const aprobarPendiente = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'APROBAR',
      });
      expect(aprobarPendiente.status).toBe(422);
      expect(JSON.stringify(aprobarPendiente.body)).toContain('faltan por revisar');
      await marcar(validador, s.solicitudId, c.items[0]!, 'NO_CUMPLE', { observacion: 'No se ve' });
      for (const i of c.items.slice(1)) await marcar(validador, s.solicitudId, i, 'CUMPLE');
      const aprobarIncumple = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'APROBAR',
      });
      expect(aprobarIncumple.status).toBe(422);
      expect(JSON.stringify(aprobarIncumple.body)).toContain('no cumple');
      const sinMotivo = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'RECHAZAR',
        motivacion: '',
      });
      expect(sinMotivo.status).toBe(422);
      expect(sinMotivo.body.error.errores.map((x: { campo: string }) => x.campo)).toContain(
        'motivacion',
      );
      const corta = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'RECHAZAR',
        motivacion: 'no sirve',
      });
      expect(corta.status).toBe(422);
      expect(await estadoDe(s.solicitudId)).toBe('EN_REVISION');
    });

    it('al aprobar la solicitud queda validada, se notifica por correo y todo queda en la bitácora', async () => {
      const s = await ay.solicitudRadicada({ correo: 'aprobada@correo.com' });
      await tomar(validador, s.solicitudId);
      await cumplirTodo(validador, s.solicitudId);
      const r = await post(validador, `/casos/${s.solicitudId}/decision`, { decision: 'APROBAR' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.estado.codigo).toBe('VALIDADA');
      // Al validarse recibe su puntaje y pasa a priorizada (RF-PRI-01).
      expect(await estadoDe(s.solicitudId)).toBe('PRIORIZADA');
      const correo = await ultimoCorreo();
      expect(correo.to).toBe('aprobada@correo.com');
      expect(correo.subject).toContain(s.radicado);
      expect(correo.text).toContain('cumple los requisitos');
      expect(correo.text).toMatch(/consulta\?token=/);
      expect(correo.text).toContain('no equivale a la aprobación');
      const detalle = await caso(validador, s.solicitudId);
      expect(detalle.decisiones).toHaveLength(1);
      expect(detalle.decisiones[0]).toMatchObject({ decision: 'APROBAR' });
      expect(detalle.validacion.puedeEditar).toBe(false);
      const b = await e.pool.query(
        `SELECT usuario_id, ip, valor_anterior, valor_nuevo, justificacion FROM bitacora
          WHERE solicitud_id = $1 AND accion = 'VALIDACION_DECIDIDA'`,
        [s.solicitudId],
      );
      expect(b.rows).toHaveLength(1);
      expect(b.rows[0].usuario_id).toBe(validador.id);
      expect(b.rows[0].valor_nuevo).toMatchObject({ estado: 'VALIDADA', decision: 'APROBAR' });
      // La decisión es inmutable.
      await expect(
        e.pool.query(
          `UPDATE validacion_decisiones SET motivacion = 'cambiada' WHERE solicitud_id = $1`,
          [s.solicitudId],
        ),
      ).rejects.toBeDefined();
      // Y el caso ya no sale en la bandeja de pendientes.
      const bandeja = await get(validador, `/bandeja?q=${s.radicado}`);
      expect(bandeja.body.total).toBe(0);
      // No se puede decidir dos veces.
      expect(
        (await post(validador, `/casos/${s.solicitudId}/decision`, { decision: 'APROBAR' })).status,
      ).toBe(409);
    });

    it('al rechazar exige motivación clara, queda «no cumple» y el correo trae la motivación y los recursos', async () => {
      const s = await ay.solicitudRadicada({ correo: 'rechazada@correo.com' });
      const c = await tomar(validador, s.solicitudId);
      for (const i of c.items) await marcar(validador, s.solicitudId, i, 'CUMPLE');
      // Sin ningún requisito «no cumple» no hay base para rechazar.
      const sinBase = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'RECHAZAR',
        motivacion: 'La persona no vive en Barranquilla según el soporte.',
      });
      expect(sinBase.status).toBe(422);
      const residencia = c.items.find((i) => i.codigo === 'PCD_RESIDENCIA')!;
      await marcar(validador, s.solicitudId, residencia, 'NO_CUMPLE', {
        observacion: 'Vive en otro municipio',
      });
      const motivo =
        'No se acreditó la residencia en Barranquilla: el soporte corresponde a otro municipio.';
      const r = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'RECHAZAR',
        motivacion: motivo,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await estadoDe(s.solicitudId)).toBe('NO_CUMPLE');
      const correo = await ultimoCorreo();
      expect(correo.to).toBe('rechazada@correo.com');
      expect(correo.text).toContain(motivo);
      expect(correo.text).toContain('recurso de reposición');
      expect(correo.text).toContain('10 días');
      expect(correo.text).toMatch(/consulta\?token=/);
    });
  });

  describe('subsanación (RF-VAL-02, RF-CAR-06)', () => {
    async function pedirSubsanacion(
      s: { solicitudId: number; token: string },
      validadorCuenta = validador,
    ) {
      const c = await tomar(validadorCuenta, s.solicitudId);
      for (const i of c.items) await marcar(validadorCuenta, s.solicitudId, i, 'CUMPLE');
      const sisben = c.items.find((i) => i.codigo === 'PCD_SISBEN')!;
      await marcar(validadorCuenta, s.solicitudId, sisben, 'NO_CUMPLE', {
        observacion: 'El soporte es de otro mes; cargue el vigente.',
      });
      const r = await post(validadorCuenta, `/casos/${s.solicitudId}/decision`, {
        decision: 'SUBSANAR',
        motivacion: 'El soporte del SISBÉN no está vigente.',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return { sisben, respuesta: r.body };
    }

    it('pide corregir solo lo señalado, con observación y plazo, y se lo avisa a la persona por correo', async () => {
      const s = await ay.solicitudRadicada({ correo: 'subsana@correo.com' });
      const { respuesta } = await pedirSubsanacion(s);
      expect(respuesta.estado.codigo).toBe('EN_SUBSANACION');
      expect(respuesta.venceAt).toBeTruthy();
      expect(await estadoDe(s.solicitudId)).toBe('EN_SUBSANACION');
      const correo = await ultimoCorreo();
      expect(correo.to).toBe('subsana@correo.com');
      expect(correo.text).toContain('SISBÉN IV grupo A, B o C');
      expect(correo.text).toContain('El soporte es de otro mes; cargue el vigente.');
      expect(correo.text).toMatch(/Tiene plazo hasta el \d{2}\/\d{2}\/\d{4}/);
      expect(correo.text).toMatch(/caracterizacion\?token=/);
      // El caso espera a la persona: ya no sale como pendiente ni se puede tomar.
      expect((await get(validador, `/bandeja?q=${s.radicado}`)).body.total).toBe(0);
      const tomaPrematura = await post(otroValidador, `/casos/${s.solicitudId}/tomar`);
      expect(tomaPrematura.status).toBe(409);
      expect(tomaPrematura.body.error.codigo).toBe('ESPERANDO_RESPUESTA');
      // La persona ve la observación y el plazo.
      const sub = (
        await request(e.app).get(`${pub}/caracterizacion/subsanacion`).set(bearer(s.token))
      ).body.subsanacion;
      expect(sub).toMatchObject({ estado: 'ABIERTA', puedeResponder: true });
      expect(sub.items).toHaveLength(1);
      expect(sub.items[0].observacion).toContain('otro mes');
      expect(sub.documentosEditables).toHaveLength(1);
    });

    it('la persona solo puede modificar los documentos y datos señalados', async () => {
      const s = await ay.solicitudRadicada();
      const { sisben } = await pedirSubsanacion(s);
      const docs = await ay.lista(s.token);
      expect(docs.editable).toBe(true);
      expect(docs.documentosEditables).toEqual([sisben.documentoId]);
      const otro = docs.documentos.find((d) => d.id !== sisben.documentoId)!;
      const prohibido = await ay.subir(s.token, otro.id, pdf('otro'), 'otro.pdf');
      expect(prohibido.status).toBe(409);
      expect(prohibido.body.error.codigo).toBe('DOCUMENTO_NO_SENALADO');
      // Tampoco puede cambiar datos que no se le pidieron.
      const c = (await request(e.app).get(`${pub}/caracterizacion`).set(bearer(s.token))).body;
      expect(c.solicitud.editable).toBe(true);
      expect(c.subsanacion.camposEditables).toEqual([]);
      const dato = await request(e.app)
        .patch(`${pub}/caracterizacion`)
        .set(bearer(s.token))
        .send({ version: c.version, celular: '3009999999' });
      expect(dato.status).toBe(422);
      expect(JSON.stringify(dato.body)).toContain(
        'Solo puede modificar lo que se le pidió corregir',
      );
      // Sí puede reemplazar el documento señalado.
      const ok = await ay.subir(s.token, sisben.documentoId!, pdf('nuevo sisben'), 'sisben.pdf');
      expect(ok.status).toBe(201);
    });

    it('al responder el caso vuelve a la bandeja como «subsanado» y se revisa sobre la misma lista de chequeo', async () => {
      const s = await ay.solicitudRadicada({ correo: 'vuelve@correo.com' });
      const { sisben } = await pedirSubsanacion(s);
      const responder = () =>
        request(e.app)
          .post(`${pub}/caracterizacion/subsanacion/responder`)
          .set(bearer(s.token))
          .send();
      // Sin el documento nuevo no se puede enviar.
      const antes = await responder();
      expect(antes.status).toBe(422);
      expect(JSON.stringify(antes.body)).toContain('Cargue el documento corregido');
      await ay.subir(s.token, sisben.documentoId!, pdf('vigente'), 'sisben-vigente.pdf');
      e.mailer.enviados.length = 0;
      const ok = await responder();
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body.estado.codigo).toBe('SUBSANADA');
      expect(await estadoDe(s.solicitudId)).toBe('SUBSANADA');
      const correo = await ultimoCorreo();
      expect(correo.to).toBe('vuelve@correo.com');
      expect(correo.text).toContain('Recibimos las correcciones');
      // Ya no admite más cambios ni una segunda respuesta.
      expect((await ay.subir(s.token, sisben.documentoId!, pdf('otra vez'), 'x.pdf')).status).toBe(
        409,
      );
      expect((await responder()).status).toBe(409);
      // Aparece en la bandeja marcado como subsanado y con el historial de documentos conservado.
      const fila = (await get(validador, `/bandeja?q=${s.radicado}`)).body.items[0];
      expect(fila).toMatchObject({ estado: { codigo: 'SUBSANADA' }, subsanado: true, ronda: 2 });
      const versiones = await e.pool.query(
        `SELECT estado FROM documentos_solicitud WHERE solicitud_id = $1 AND documento_id = $2 ORDER BY id`,
        [s.solicitudId, sisben.documentoId],
      );
      expect(versiones.rows.map((x) => x.estado)).toEqual(['REEMPLAZADO', 'CARGADO']);
      // El validador retoma la misma lista: lo que cumplía sigue cumpliendo; el requisito corregido se revisa de nuevo.
      const c = await tomar(validador, s.solicitudId);
      expect(c.items.filter((i) => i.resultado === 'CUMPLE')).toHaveLength(c.items.length - 1);
      expect(c.items.find((i) => i.id === sisben.id)!.resultado).toBe('NO_CUMPLE');
      await marcar(validador, s.solicitudId, sisben, 'CUMPLE');
      await capturarVariables(validador, s.solicitudId);
      const aprobada = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'APROBAR',
      });
      expect(aprobada.status, JSON.stringify(aprobada.body)).toBe(201);
      expect(c.decisiones).toHaveLength(1);
      const historial = await caso(validador, s.solicitudId);
      expect(historial.decisiones.map((d) => d.decision)).toEqual(['SUBSANAR', 'APROBAR']);
    });

    it('un requisito que la persona no puede corregir no se puede pedir subsanar, y las rondas tienen un máximo', async () => {
      const s = await ay.solicitudRadicada();
      const c = await tomar(validador, s.solicitudId);
      // Un requisito sin documento ni datos no es subsanable.
      await e.pool.query(
        `UPDATE validacion_items SET documento_id = NULL, campos = '{}' WHERE id = $1`,
        [c.items[0]!.id],
      );
      await marcar(validador, s.solicitudId, c.items[0]!, 'NO_CUMPLE', { observacion: 'Falla' });
      const noSub = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'SUBSANAR',
        motivacion: 'Corregir lo indicado',
      });
      expect(noSub.status).toBe(422);
      expect(JSON.stringify(noSub.body)).toContain('no puede corregir');
      // Sin observación tampoco.
      const otro = c.items.find((i) => i.documentoId !== null && i.id !== c.items[0]!.id)!;
      await marcar(validador, s.solicitudId, c.items[0]!, 'CUMPLE');
      await marcar(validador, s.solicitudId, otro, 'NO_CUMPLE', { observacion: '' });
      const sinObs = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'SUBSANAR',
        motivacion: 'Corregir lo indicado',
      });
      expect(sinObs.status).toBe(422);
      expect(JSON.stringify(sinObs.body)).toContain('Escriba qué debe corregir');
      // Máximo de rondas (parámetro): con 1 solo se puede pedir una vez.
      for (const i of c.items.filter((x) => x.id !== otro.id))
        await marcar(validador, s.solicitudId, i, 'CUMPLE');
      await request(e.app)
        .post(`${adm}/parametros/max_rondas_subsanacion/versiones`)
        .set(auth(administrador))
        .send({ valor: '1', justificacion: 'Una sola ronda en esta prueba' });
      await marcar(validador, s.solicitudId, otro, 'NO_CUMPLE', {
        observacion: 'Cargue el documento completo',
      });
      const primera = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'SUBSANAR',
        motivacion: 'Primera ronda',
      });
      expect(primera.status, JSON.stringify(primera.body)).toBe(201);
      await request(e.app)
        .post(`${pub}/caracterizacion/documentos/${otro.documentoId}`)
        .set(bearer(s.token))
        .attach('archivo', pdf('completo'), 'completo.pdf');
      await request(e.app)
        .post(`${pub}/caracterizacion/subsanacion/responder`)
        .set(bearer(s.token))
        .send()
        .expect(200);
      await tomar(validador, s.solicitudId);
      await marcar(validador, s.solicitudId, otro, 'NO_CUMPLE', {
        observacion: 'Sigue incompleto',
      });
      const segunda = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'SUBSANAR',
        motivacion: 'Segunda ronda',
      });
      expect(segunda.status).toBe(422);
      expect(JSON.stringify(segunda.body)).toContain('Ya se agotó el máximo');
      await request(e.app)
        .post(`${adm}/parametros/max_rondas_subsanacion/versiones`)
        .set(auth(administrador))
        .send({ valor: '2', justificacion: 'Volver al valor normal' });
    });

    it('si el plazo vence sin respuesta, el caso queda para decisión del validador, que puede rechazar por falta de respuesta', async () => {
      const s = await ay.solicitudRadicada({ correo: 'vencida@correo.com' });
      const { sisben } = await pedirSubsanacion(s);
      await e.pool.query(
        `UPDATE subsanaciones SET vence_at = now() - interval '1 hour' WHERE solicitud_id = $1`,
        [s.solicitudId],
      );
      // La persona ya no puede modificar ni responder.
      const sub = (
        await request(e.app).get(`${pub}/caracterizacion/subsanacion`).set(bearer(s.token))
      ).body.subsanacion;
      expect(sub).toMatchObject({ estado: 'VENCIDA', puedeResponder: false });
      expect((await ay.subir(s.token, sisben.documentoId!, pdf('tarde'), 'tarde.pdf')).status).toBe(
        409,
      );
      expect(
        (
          await request(e.app)
            .post(`${pub}/caracterizacion/subsanacion/responder`)
            .set(bearer(s.token))
            .send()
        ).status,
      ).toBe(409);
      // El caso vuelve a la bandeja marcado con el plazo vencido.
      const fila = (await get(validador, `/bandeja?q=${s.radicado}`)).body.items[0];
      expect(fila).toMatchObject({
        estado: { codigo: 'EN_SUBSANACION' },
        subsanacionVencida: true,
      });
      await tomar(validador, s.solicitudId);
      e.mailer.enviados.length = 0;
      const r = await post(validador, `/casos/${s.solicitudId}/decision`, {
        decision: 'RECHAZAR',
        motivacion: 'No respondió la solicitud de subsanación dentro del plazo señalado.',
      });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await estadoDe(s.solicitudId)).toBe('NO_CUMPLE');
      expect((await ultimoCorreo()).text).toContain('recurso de reposición');
    });
  });

  describe('lista de chequeo parametrizable (RN-05, RF-ADM-04)', () => {
    const adminGet = (c: CuentaPrueba, ruta: string) =>
      request(e.app).get(`${adm}${ruta}`).set(auth(c));
    const adminPost = (c: CuentaPrueba, ruta: string, cuerpo: object = {}) =>
      request(e.app).post(`${adm}${ruta}`).set(auth(c)).send(cuerpo);
    const adminPut = (c: CuentaPrueba, ruta: string, cuerpo: object) =>
      request(e.app).put(`${adm}${ruta}`).set(auth(c)).send(cuerpo);

    it('solo quien administra los requisitos los ve y los modifica', async () => {
      expect((await adminGet(validador, '/requisitos')).status).toBe(403);
      expect((await adminGet(analista, '/requisitos')).status).toBe(403);
      const r = await adminGet(administrador, '/requisitos');
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeGreaterThanOrEqual(13);
      expect(r.body.items.map((x: { codigo: string }) => x.codigo)).toContain('PCD_SISBEN');
    });

    it('un requisito nuevo se pide solo a los casos que empiezan después; los que ya empezaron conservan su lista', async () => {
      const antes = await ay.solicitudRadicada();
      await tomar(validador, antes.solicitudId);
      const nuevo = await adminPost(administrador, '/requisitos', {
        nombre: 'Constancia de convivencia',
        descripcion: 'Acredita que vive con el cuidador.',
        aplicaA: 'COMUN',
        fuenteSugerida: 'Visita o declaración',
        documentoId: null,
        campos: ['requiereCuidador'],
        cruceCodigo: null,
      });
      expect(nuevo.status, JSON.stringify(nuevo.body)).toBe(201);
      expect(nuevo.body.codigo).toBe('COM_CONSTANCIA_DE_CONVIVENCIA');
      const despues = await ay.solicitudRadicada();
      const c2 = await tomar(otroValidador, despues.solicitudId);
      expect(c2.items.map((i) => i.codigo)).toContain('COM_CONSTANCIA_DE_CONVIVENCIA');
      const c1 = await caso(validador, antes.solicitudId);
      expect(c1.items.map((i) => i.codigo)).not.toContain('COM_CONSTANCIA_DE_CONVIVENCIA');
      // Modificar y desactivar queda versionado y registrado.
      const id = nuevo.body.id as number;
      const mod = await adminPut(administrador, `/requisitos/${id}`, {
        nombre: 'Constancia de convivencia',
        descripcion: 'Texto ajustado',
        aplicaA: 'COMUN',
        fuenteSugerida: '',
        documentoId: null,
        campos: [],
        cruceCodigo: null,
      });
      expect(mod.body.version).toBe(2);
      expect((await adminPost(administrador, `/requisitos/${id}/desactivar`)).body.activo).toBe(
        false,
      );
      expect((await adminPost(administrador, `/requisitos/${id}/desactivar`)).status).toBe(409);
      const v = await adminGet(administrador, `/requisitos/${id}/versiones`);
      expect(v.body.items).toHaveLength(3);
      const tercero = await ay.solicitudRadicada();
      const c3 = await tomar(validador, tercero.solicitudId);
      expect(c3.items.map((i) => i.codigo)).not.toContain('COM_CONSTANCIA_DE_CONVIVENCIA');
      const b = await e.pool.query(
        `SELECT accion FROM bitacora WHERE entidad = 'requisito' AND entidad_id = $1 AND accion LIKE 'REQUISITO_%' ORDER BY id`,
        [String(id)],
      );
      expect(b.rows.map((x) => x.accion)).toEqual([
        'REQUISITO_CREADO',
        'REQUISITO_MODIFICADO',
        'REQUISITO_DESACTIVADO',
      ]);
    });

    it('valida los datos del requisito con mensajes por campo', async () => {
      const malo = await adminPost(administrador, '/requisitos', {
        nombre: 'x',
        aplicaA: 'OTRO',
        documentoId: 99999,
        campos: ['noExiste'],
        cruceCodigo: 'INVENTADO',
      });
      expect(malo.status).toBe(422);
      const campos = malo.body.error.errores.map((x: { campo: string }) => x.campo);
      expect(campos).toEqual(expect.arrayContaining(['nombre', 'aplicaA']));
      const repetido = await adminPost(administrador, '/requisitos', {
        nombre: 'Identidad de la persona con discapacidad',
        aplicaA: 'PCD',
        documentoId: null,
        campos: [],
        cruceCodigo: null,
      });
      expect(repetido.status).toBe(422);
      expect(JSON.stringify(repetido.body)).toContain('ya existe');
      const sinCatalogo = await adminPost(administrador, '/requisitos', {
        nombre: 'Requisito con datos inexistentes',
        aplicaA: 'PCD',
        documentoId: 99999,
        campos: ['noExiste'],
        cruceCodigo: 'INVENTADO',
      });
      expect(sinCatalogo.status).toBe(422);
      expect(sinCatalogo.body.error.errores.map((x: { campo: string }) => x.campo)).toEqual(
        expect.arrayContaining(['campos', 'documentoId', 'cruceCodigo']),
      );
    });
  });
});
