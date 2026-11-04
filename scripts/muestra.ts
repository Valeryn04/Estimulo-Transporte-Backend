import request from 'supertest';
import { loadEnv } from '../src/config/env.js';
import { crearDependencias } from '../src/container.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';
import { MemoryMailer } from '../src/infrastructure/mail/mailer.js';
import { hashPassword } from '../src/infrastructure/security/passwords.js';
import { TurnstileDesactivado } from '../src/infrastructure/security/turnstile.js';
import { crearAplicacion } from '../src/presentation/http/app.js';

/**
 * Deja la base de datos lista para una MUESTRA del software: configuración principal hecha, una persona por rol y
 * solicitudes en cada etapa del proceso. BORRA los datos actuales (hágase un respaldo antes: npm run respaldo).
 * Uso: npm run muestra -- --si
 */
if (!process.argv.includes('--si')) {
  console.error(
    'Esto borra TODOS los datos y deja la base lista para la muestra. Ejecute: npm run muestra -- --si',
  );
  process.exit(1);
}
const CLAVE = '12345@Esti';
const env = loadEnv();
if (env.nodeEnv === 'production') throw new Error('No se puede ejecutar en producción.');
const deps = crearDependencias(env);
const pool = deps.pool;
const reloj = { ahora: new Date() };
const mailer = new MemoryMailer();
deps.mailer = mailer; // nada sale por correo desde este script
deps.turnstile = new TurnstileDesactivado();
deps.ahora = () => reloj.ahora;

const api = '/api/v1';
const adm = `${api}/admin`;
const pub = `${api}/publico`;
// Un PDF de dos hojas sirve para todo, también para el certificado de discapacidad, que exige dos.
let pdfDosHojas = Buffer.alloc(0);
const pdf = (_relleno = 'contenido') => pdfDosHojas;
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const tokenDe = (texto: string) => /token=([A-Za-z0-9_-]+)/.exec(texto)![1]!;
const hoy = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const enDias = (n: number) =>
  new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

function exigir(r: request.Response, que: string): request.Response {
  if (r.status >= 400) throw new Error(`${que}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

async function main() {
  {
    const { PDFDocument } = await import('pdf-lib');
    const d = await PDFDocument.create();
    d.addPage();
    d.addPage();
    pdfDosHojas = Buffer.from(await d.save());
  }
  // ------------------------------------------------------------------ 1. Base de datos vacía y cuentas
  const previo = (
    await pool
      .query<{ usuario: string; nombres: string; correo: string; password_hash: string }>(
        `SELECT usuario, nombres, correo, password_hash FROM usuarios WHERE protegido LIMIT 1`,
      )
      .catch(() => ({ rows: [] }))
  ).rows[0];
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
  const { app, servicios } = crearAplicacion(deps, { limitarIntentos: false });

  const crearUsuario = async (
    usuario: string,
    nombres: string,
    rol: string,
    hash: string,
    protegido = false,
  ) => {
    const r = await pool.query<{ id: number }>(
      `INSERT INTO usuarios (usuario, nombres, correo, password_hash, debe_cambiar_password, protegido)
       VALUES ($1, $2, $3, $4, false, $5) RETURNING id`,
      [usuario, nombres, `${usuario}@alcaldia.test`, hash, protegido],
    );
    await pool.query(
      `INSERT INTO usuario_rol (usuario_id, rol_id) SELECT $1, id FROM roles WHERE codigo = $2`,
      [r.rows[0]!.id, rol],
    );
    return r.rows[0]!.id;
  };
  // El administrador principal conserva su propia contraseña.
  const hashAdmin =
    previo?.password_hash ?? (await hashPassword(process.env['ADMIN_PASSWORD'] ?? CLAVE));
  await crearUsuario(
    previo?.usuario ?? 'admin',
    previo?.nombres ?? 'Administrador de la plataforma',
    'ADMINISTRADOR',
    hashAdmin,
    true,
  );
  const hashMuestra = await hashPassword(CLAVE);
  const cuentas: [string, string, string][] = [
    ['administrador', 'Administrador de la muestra', 'ADMINISTRADOR'],
    ['responsable', 'Responsable del proceso', 'RESPONSABLE_PROCESO'],
    ['validador', 'Auditor verificador 1', 'AUDITOR_VERIFICADOR'],
    ['validador2', 'Auditor verificador 2', 'AUDITOR_VERIFICADOR'],
    ['asignador', 'Asignador del beneficio', 'ASIGNADOR'],
    ['gestor', 'Gestor de novedades', 'GESTOR_NOVEDADES'],
    ['analista', 'Analista del programa', 'ANALISTA'],
    ['control', 'Control interno', 'CONTROL_INTERNO'],
  ];
  const ids: Record<string, number> = {};
  for (const [u, n, r] of cuentas) ids[u] = await crearUsuario(u, n, r, hashMuestra);

  const entrar = async (usuario: string) =>
    exigir(
      await request(app).post(`${api}/auth/login`).send({ usuario, password: CLAVE }),
      `login ${usuario}`,
    ).body.token as string;
  const t: Record<string, string> = {};
  for (const [u] of cuentas) t[u] = await entrar(u);

  const get = (u: string, ruta: string) => request(app).get(`${adm}${ruta}`).set(bearer(t[u]!));
  const post = (u: string, ruta: string, cuerpo: object = {}) =>
    request(app).post(`${adm}${ruta}`).set(bearer(t[u]!)).send(cuerpo);
  const put = (u: string, ruta: string, cuerpo: object) =>
    request(app).put(`${adm}${ruta}`).set(bearer(t[u]!)).send(cuerpo);
  const multipart = (u: string, ruta: string, datos: object, archivo = true) => {
    const r = request(app)
      .post(`${adm}${ruta}`)
      .set(bearer(t[u]!))
      .field('datos', JSON.stringify(datos));
    return archivo ? r.attach('archivo', pdf('soporte'), 'soporte.pdf') : r;
  };

  // ------------------------------------------------------------------ 2. Configuración principal
  const param = async (clave: string, valor: string) =>
    exigir(
      await post('administrador', `/parametros/${clave}/versiones`, {
        valor,
        justificacion: 'Configuración de la muestra',
      }),
      `parámetro ${clave}`,
    );
  await param('plazo_subsanacion_dias', '3');
  await param('entrega_activacion_inmediata', 'true');
  await param(
    'entrega_lugar',
    'Punto de atención de la Gerencia de Desarrollo Social, Calle 34 # 43-31, Barranquilla. Lunes a viernes, de 8:00 a. m. a 4:00 p. m.',
  );
  exigir(
    await request(app)
      .put(`${adm}/asignacion/cupos`)
      .set(bearer(t['responsable']!))
      .field(
        'datos',
        JSON.stringify({
          cuposTotales: 6,
          valorEstimulo: 500_000,
          presupuestoTotal: 6_000_000,
          motivo: 'Configuración inicial de cupos y presupuesto de la vigencia 2026',
        }),
      )
      .attach('archivo', pdf('acto'), 'acto-presupuestal-2026.pdf'),
    'cupos',
  );

  // ------------------------------------------------------------------ 3. Personas (flujo del ciudadano)
  const formulario = async () => (await request(app).get(`${pub}/preinscripcion/formulario`)).body;
  const f0 = await formulario();
  const cc = f0.tiposIdentificacion.find((x: { codigo: string }) => x.codigo === 'CC').id as number;
  const localidades = f0.localidades as { id: number; nombre: string }[];
  const barrios = f0.barrios as { id: number; localidadId: number }[];
  let consecutivo = 1_002_000_000;

  async function preinscribir(
    nombre: string,
    cuidador: string | null,
    n: number,
  ): Promise<{ solicitudId: number; correo: string }> {
    const f = await formulario();
    reloj.ahora = new Date(Date.now() + 60_000); // lo que tardaría una persona en llenar el formulario
    consecutivo += 2;
    const loc = localidades[n % localidades.length]!;
    const barrio = barrios.find((b) => b.localidadId === loc.id);
    const correo = `${nombre.split(' ')[0]!.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')}${n}@correo.com`;
    const r = await request(app)
      .post(`${pub}/preinscripciones`)
      .send({
        pcdNombre: nombre,
        pcdTipoIdentificacionId: cc,
        pcdNumero: String(consecutivo),
        diligenciadaPor: 'PCD',
        tieneCuidador: cuidador !== null,
        ...(cuidador
          ? {
              cuidadorNombre: cuidador,
              cuidadorTipoIdentificacionId: cc,
              cuidadorNumero: String(consecutivo + 1),
            }
          : {}),
        direccion: `Carrera ${40 + n} # ${20 + n} - ${10 + n}`,
        localidadId: loc.id,
        ...(barrio ? { barrioId: barrio.id } : {}),
        correo,
        correoConfirmacion: correo,
        aceptaAutorizacion: true,
        autorizacionVersion: f.autorizacion.version,
        formularioToken: f.formularioToken,
      });
    reloj.ahora = new Date();
    exigir(r, `preinscripción de ${nombre}`);
    await servicios.correos.esperarDespachos();
    const s = await pool.query<{ id: number }>(
      `SELECT s.id FROM solicitudes s JOIN personas p ON p.id = s.pcd_id WHERE p.numero_identificacion = $1`,
      [String(consecutivo)],
    );
    return { solicitudId: s.rows[0]!.id, correo };
  }

  async function verificar(): Promise<string> {
    await request(app)
      .post(`${pub}/preinscripciones/verificar-correo`)
      .send({ token: tokenDe(mailer.ultimo().text) });
    await servicios.correos.esperarDespachos();
    const sesion = await request(app)
      .post(`${pub}/consulta/enlace`)
      .send({ token: tokenDe(mailer.ultimo().text) });
    return exigir(sesion, 'enlace de consulta').body.token as string;
  }

  async function radicar(tk: string, cuidador: boolean, n: number): Promise<string> {
    const c = (await request(app).get(`${pub}/caracterizacion`).set(bearer(tk))).body;
    const id = (l: { id: number; codigo: string }[], codigo: string) =>
      l.find((i) => i.codigo === codigo)!.id;
    const claveTransporte = Object.keys(c.catalogos).find((k) => /transporte/i.test(k));
    const transportes = claveTransporte ? (c.catalogos[claveTransporte] as { id: number }[]) : [];
    exigir(
      await request(app)
        .patch(`${pub}/caracterizacion`)
        .set(bearer(tk))
        .send({
          version: c.version,
          generoId: id(c.catalogos.generos, n % 2 ? 'FEMENINO' : 'MASCULINO'),
          celular: `30012345${String(10 + n).slice(-2)}`,
          ocupacionId: id(c.catalogos.ocupaciones, 'DESEMPLEADO'),
          epsId: id(c.catalogos.eps, 'SANITAS'),
          embarazo: 'NO',
          recibeSubsidios: false,
          ...(transportes.length
            ? { tipoTransporteId: transportes[n % transportes.length]!.id }
            : {}),
          requiereCuidador: cuidador,
          ...(cuidador
            ? {
                cuidadorGeneroId: id(c.catalogos.generos, 'MASCULINO'),
                cuidadorCelular: '3109876543',
                cuidadorCorreo: `cuidador${n}@correo.com`,
              }
            : {}),
        }),
      'caracterización',
    );
    const docs = (await request(app).get(`${pub}/caracterizacion/documentos`).set(bearer(tk))).body
      .documentos as { id: number; codigo: string; obligatorio: boolean; generado: boolean }[];
    // Las cartas las genera el sistema solas al radicar.
    for (const d of docs.filter((x) => x.obligatorio && !x.generado)) {
      exigir(
        await request(app)
          .post(`${pub}/caracterizacion/documentos/${d.id}`)
          .set(bearer(tk))
          .attach('archivo', pdf(d.codigo), `${d.codigo}.pdf`),
        `documento ${d.codigo}`,
      );
    }
    const r = exigir(
      await request(app).post(`${pub}/caracterizacion/radicar`).set(bearer(tk)).send(),
      'radicación',
    );
    await servicios.correos.esperarDespachos();
    return r.body.radicado as string;
  }

  // nombre, cuidador (nombre o null), etapa final
  const guion: [string, string | null, string][] = [
    ['Luz Marina Barrios Pacheco', 'Carlos Barrios Pacheco', 'PRIORIZADA'],
    ['Jorge Eliécer Polo Vargas', null, 'PRIORIZADA'],
    ['Rosa Elena Castillo Mejía', 'Miguel Castillo Mejía', 'PRIORIZADA'],
    ['Carlos Arturo Mendoza Rueda', null, 'PRIORIZADA'],
    ['Yolanda Pérez Ortiz', 'Ana Pérez Ortiz', 'PRIORIZADA'],
    ['Ismael Torres Ballestas', null, 'PRIORIZADA'],
    ['Martha Lucía Fernández Cantillo', 'Jorge Fernández Cantillo', 'PRIORIZADA'],
    ['Wilson Enrique Herrera Daza', null, 'PRIORIZADA'],
    ['Gloria Patricia Cervantes Lara', null, 'PRIORIZADA'],
    ['Edgardo Manuel Navarro Pinto', 'Elena Navarro Pinto', 'SUBSANACION'],
    ['Nubia Esther Acosta Camargo', null, 'NO_CUMPLE'],
    ['Pedro Antonio Reales Guerra', null, 'EN_REVISION'],
    ['Sandra Milena Ospino Barraza', 'Luis Ospino Barraza', 'ASIGNADA_VALIDADOR'],
    ['Hernando José Díaz Montes', null, 'ASIGNADA_VALIDADOR'],
    ['Alba Luz Ríos Sarmiento', 'Pablo Ríos Sarmiento', 'RADICADA'],
    ['Fabio Andrés Mora Escorcia', null, 'RADICADA'],
    ['Teresa de Jesús Palencia Gómez', null, 'RADICADA'],
    ['Rafael Ángel Cueto Sierra', 'Dora Cueto Sierra', 'VERIFICADA'],
    ['Liliana Marcela Jiménez Pardo', null, 'PREINSCRITA'],
  ];

  const solicitudes: {
    nombre: string;
    solicitudId: number;
    radicado?: string;
    cuidador: boolean;
    etapa: string;
  }[] = [];
  for (const [n, [nombre, cuidador, etapa]] of guion.entries()) {
    const p = await preinscribir(nombre, cuidador, n);
    let radicado: string | undefined;
    if (etapa !== 'PREINSCRITA') {
      const tk = await verificar();
      if (etapa !== 'VERIFICADA') radicado = await radicar(tk, cuidador !== null, n);
    }
    solicitudes.push({
      nombre,
      solicitudId: p.solicitudId,
      radicado,
      cuidador: cuidador !== null,
      etapa,
    });
    console.log(`  · ${nombre} → ${radicado ?? etapa}`);
  }

  // ------------------------------------------------------------------ 4. Validación
  const asignarValidacion = async (ids2: number[], validador: string) =>
    exigir(
      await post('responsable', '/validacion/asignar', {
        solicitudIds: ids2,
        validadorId: ids[validador],
      }),
      'asignar caso',
    );
  const tomar = async (u: string, id: number) =>
    exigir(await post(u, `/validacion/casos/${id}/tomar`), 'abrir caso').body as {
      items: { id: number; documentoId: number | null; subsanable: boolean }[];
      priorizacion: { variables: { codigo: string; opciones: { codigo: string }[] }[] };
    };
  const marcar = async (
    u: string,
    id: number,
    itemId: number,
    resultado: string,
    observacion = '',
  ) =>
    exigir(
      await put(u, `/validacion/casos/${id}/items/${itemId}`, {
        resultado,
        fuente: resultado === 'CUMPLE' ? 'Consulta de la fuente oficial' : '',
        observacion,
        evidencia: '',
      }),
      'requisito',
    );

  let k = 0;
  for (const s of solicitudes.filter((x) => x.etapa === 'PRIORIZADA')) {
    const validador = k % 2 ? 'validador2' : 'validador';
    await asignarValidacion([s.solicitudId], validador);
    const caso = await tomar(validador, s.solicitudId);
    for (const it of caso.items) await marcar(validador, s.solicitudId, it.id, 'CUMPLE');
    for (const [j, v] of caso.priorizacion.variables.entries()) {
      const o = v.opciones[(k + j * 2) % v.opciones.length]!;
      exigir(
        await put(validador, `/validacion/casos/${s.solicitudId}/variables/${v.codigo}`, {
          valor: o.codigo,
        }),
        'dato de priorización',
      );
    }
    exigir(
      await post(validador, `/validacion/casos/${s.solicitudId}/decision`, {
        decision: 'APROBAR',
        motivacion: '',
      }),
      'aprobar',
    );
    k++;
  }
  // Pendiente de subsanación
  const sub = solicitudes.find((x) => x.etapa === 'SUBSANACION')!;
  await asignarValidacion([sub.solicitudId], 'validador');
  const cSub = await tomar('validador', sub.solicitudId);
  const conDoc = cSub.items.find((i) => i.documentoId !== null && i.subsanable)!;
  for (const it of cSub.items) {
    if (it.id === conDoc.id)
      await marcar(
        'validador',
        sub.solicitudId,
        it.id,
        'NO_CUMPLE',
        'El documento está ilegible: cárguelo de nuevo en buena calidad.',
      );
    else await marcar('validador', sub.solicitudId, it.id, 'CUMPLE');
  }
  exigir(
    await post('validador', `/validacion/casos/${sub.solicitudId}/decision`, {
      decision: 'SUBSANAR',
      motivacion: 'Falta un documento legible para poder verificar el requisito.',
    }),
    'pedir subsanación',
  );
  // Rechazada
  const rech = solicitudes.find((x) => x.etapa === 'NO_CUMPLE')!;
  await asignarValidacion([rech.solicitudId], 'validador2');
  const cRech = await tomar('validador2', rech.solicitudId);
  for (const [i, it] of cRech.items.entries()) {
    await marcar(
      'validador2',
      rech.solicitudId,
      it.id,
      i === 0 ? 'NO_CUMPLE' : 'CUMPLE',
      i === 0 ? 'No reside en Barranquilla según la verificación.' : '',
    );
  }
  exigir(
    await post('validador2', `/validacion/casos/${rech.solicitudId}/decision`, {
      decision: 'RECHAZAR',
      motivacion:
        'La persona no cumple el requisito de residencia en Barranquilla verificado en la fuente oficial.',
    }),
    'rechazar',
  );
  // En revisión (abierto por el validador) y asignados sin abrir
  const rev = solicitudes.find((x) => x.etapa === 'EN_REVISION')!;
  await asignarValidacion([rev.solicitudId], 'validador');
  await tomar('validador', rev.solicitudId);
  const asig = solicitudes.filter((x) => x.etapa === 'ASIGNADA_VALIDADOR');
  await asignarValidacion([asig[0]!.solicitudId], 'validador');
  await asignarValidacion([asig[1]!.solicitudId], 'validador2');

  // ------------------------------------------------------------------ 5. Asignación del beneficio y entregas
  const propuesta = exigir(await get('asignador', '/asignacion/propuesta?tamano=100'), 'propuesta')
    .body.items as {
    solicitudId: number;
    radicado: string;
    alcanza: boolean;
  }[];
  const primeros = propuesta.filter((x) => x.alcanza).slice(0, 5);
  const asignados = exigir(
    await post('asignador', '/asignacion/asignar', {
      solicitudIds: primeros.map((x) => x.solicitudId),
      omisiones: [],
    }),
    'asignar beneficios',
  ).body.items as { solicitudId: number; radicado: string; beneficioId: number }[];
  const detalle = async (id: number) =>
    exigir(await get('asignador', `/asignacion/beneficiarios/${id}`), 'beneficio').body;
  const entregar = async (beneficioId: number, n: number) => {
    const d = await detalle(beneficioId);
    const transporte = d.sugerencias.tipoTransporteId ?? d.opciones.tiposTransporte[0].id;
    for (const rol of d.pendientes as ('PCD' | 'CUIDADOR')[]) {
      exigir(
        await multipart('asignador', `/asignacion/beneficiarios/${beneficioId}/entregas`, {
          rol,
          tarjetaId: `MFPLUS-EV-${String(10_000 + n * 2 + (rol === 'PCD' ? 0 : 1)).padStart(8, '0')}`,
          tipoTransporteId: transporte,
          fechaEntrega: hoy(),
          receptorTipo: rol,
        }),
        'entrega',
      );
    }
  };
  // 0 y 1: activos; 2: pendiente de entrega; 3: bloqueado; 4: con revocatoria en curso
  await entregar(asignados[0]!.beneficioId, 0);
  await entregar(asignados[1]!.beneficioId, 1);
  await entregar(asignados[3]!.beneficioId, 3);
  await entregar(asignados[4]!.beneficioId, 4);
  const causal = async (cat: string) =>
    (
      await pool.query<{ id: number }>(
        `SELECT id FROM catalogo_items WHERE catalogo = $1 AND activo ORDER BY id LIMIT 1`,
        [cat],
      )
    ).rows[0]!.id;
  exigir(
    await multipart('gestor', `/novedades/beneficios/${asignados[3]!.beneficioId}/novedades`, {
      tipo: 'BLOQUEO',
      causalId: await causal('CAUSAL_BLOQUEO'),
      fechaEfectiva: hoy(),
      observacion: 'Reporte de pérdida de la tarjeta por parte de la familia.',
    }),
    'bloqueo',
  );
  const revoc = exigir(
    await multipart('gestor', `/novedades/beneficios/${asignados[4]!.beneficioId}/revocatorias`, {
      causalId: await causal('CAUSAL_REVOCATORIA'),
      descripcion: 'Se reportó el uso de la tarjeta por una persona distinta al beneficiario.',
    }),
    'revocatoria',
  );
  const revId = revoc.body.id as number;
  exigir(
    await multipart('gestor', `/novedades/revocatorias/${revId}/traslado`, {
      texto:
        'Se le informa que hay un reporte de uso de la tarjeta por otra persona. Puede presentar sus descargos dentro del plazo.',
    }),
    'traslado',
  );
  // Lista de espera para los que ya no caben
  exigir(await post('asignador', '/asignacion/lista-espera', {}), 'lista de espera');
  // Una excepción para que el responsable la decida en la muestra
  const pendienteAsignar = (await get('asignador', '/asignacion/propuesta?tamano=100')).body
    .items as {
    solicitudId: number;
    radicado: string;
    alcanza: boolean;
  }[];
  const paraExcepcion = pendienteAsignar[0] ?? propuesta[propuesta.length - 1]!;
  exigir(
    await request(app)
      .post(`${adm}/priorizacion/casos/${paraExcepcion.solicitudId}/excepciones`)
      .set(bearer(t['asignador']!))
      .field('ajuste', '10')
      .field(
        'justificacion',
        'Persona en tratamiento semanal y sin red de apoyo familiar verificada en visita.',
      )
      .attach('archivo', pdf('soporte'), 'visita-social.pdf'),
    'excepción',
  );
  // Una versión nueva de la matriz pendiente de aprobación
  const nueva = exigir(await post('administrador', '/matriz', {}), 'nueva matriz').body;
  exigir(
    await post('administrador', `/matriz/${nueva.id}/solicitar-aprobacion`),
    'pedir aprobación de la matriz',
  );

  // ------------------------------------------------------------------ 6. Encuesta con algunas respuestas
  const enc = exigir(
    await post('administrador', '/encuestas', {
      titulo: 'Satisfacción con el Estímulo Social de Transporte 2026',
      descripcion: 'Queremos conocer su experiencia con el servicio.',
      desde: hoy(),
      hasta: enDias(30),
      preguntas: [
        {
          tipo: 'ESCALA',
          texto: '¿Qué tan satisfecho está con el servicio?',
          obligatoria: true,
          escalaMax: 5,
        },
        {
          tipo: 'SELECCION',
          texto: '¿Con qué frecuencia usa la tarjeta?',
          obligatoria: true,
          opciones: ['Todos los días', 'Varias veces por semana', 'Una vez por semana'],
        },
        { tipo: 'TEXTO', texto: '¿Qué mejoraría del servicio?', obligatoria: false },
      ],
    }),
    'encuesta',
  ).body;
  exigir(await post('administrador', `/encuestas/${enc.id}/publicar`), 'publicar encuesta');
  await servicios.correos.esperarDespachos();
  const preguntas = (exigir(await get('administrador', `/encuestas/${enc.id}`), 'encuesta').body
    .preguntas ?? []) as { id: number }[];
  const invitaciones = (
    await pool.query<{ cuerpo: string }>(
      `SELECT cuerpo FROM correos WHERE tipo = 'ENCUESTA_INVITACION' ORDER BY id`,
    )
  ).rows;
  const textos = ['Más rutas hacia el norte de la ciudad.', 'Muy buen servicio, gracias.'];
  for (const [i, inv] of invitaciones.slice(0, 2).entries()) {
    exigir(
      await request(app)
        .post(`${pub}/encuesta/responder`)
        .send({
          token: tokenDe(inv.cuerpo),
          respuestas: {
            [preguntas[0]!.id]: 5 - i,
            [preguntas[1]!.id]: i ? 'Varias veces por semana' : 'Todos los días',
            [preguntas[2]!.id]: textos[i],
          },
        }),
      'responder encuesta',
    );
  }

  // Los avisos de la campana deben corresponder a lo que sigue pendiente, no a todo lo que ocurrió al armar la muestra.
  await pool.query(
    `DELETE FROM alertas a USING solicitudes s
      WHERE s.id = a.solicitud_id
        AND ((a.tipo = 'CASO_RADICADO' AND s.estado <> 'RADICADA')
          OR (a.tipo = 'CASO_PRIORIZADO' AND s.estado <> 'PRIORIZADA')
          OR (a.tipo = 'CASOS_ASIGNADOS' AND s.estado NOT IN ('RADICADA', 'EN_REVISION'))
          OR a.tipo IN ('CASO_DEVUELTO', 'SUBSANACION_RECIBIDA', 'SUBSANACION_VENCIDA'))`,
  );
  // Y el aviso de una asignación a un validador solo queda si el caso sigue pendiente de revisar.
  // Lo enviado desde este script no sale a ninguna parte: no queda nada pendiente de despacho.
  await pool
    .query(`UPDATE correos SET estado = 'ENTREGADO' WHERE estado IN ('PENDIENTE', 'ENVIADO')`)
    .catch(() => undefined);
  console.log('\nMuestra lista.');
}

try {
  await main();
} finally {
  await pool.end();
}
