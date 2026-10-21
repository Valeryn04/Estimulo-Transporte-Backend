import { randomInt } from 'node:crypto';
import { loadEnv } from '../src/config/env.js';
import { generarPasswordTemporal } from '../src/domain/passwords.js';
import { createPool } from '../src/infrastructure/db/pool.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';
import { hashPassword } from '../src/infrastructure/security/passwords.js';

/**
 * Datos de demostración SOLO PARA DESARROLLO: un funcionario por rol y varias solicitudes radicadas, creadas por la
 * API pública como lo haría una persona. Sirve para recorrer las pantallas del portal interno.
 *
 *   npm run demo:datos            (la API debe estar encendida en el puerto indicado en .env)
 *   npm run demo:datos -- 10      (cantidad de solicitudes; por defecto 6)
 *   npm run demo:datos -- 10 --validar   (además, el validador revisa y aprueba las solicitudes nuevas)
 *
 * Las contraseñas de los funcionarios se generan en cada ejecución y se muestran una sola vez en la terminal.
 */
const env = loadEnv();
if (env.nodeEnv === 'production') {
  console.error('Este script no se puede usar en producción.');
  process.exit(1);
}
const API = `http://localhost:${env.port}/api/v1`;
const cantidad = Math.max(0, Math.min(40, Number(process.argv[2] ?? 6) || 6));
const validar = process.argv.includes('--validar');

const pool = createPool(env.databaseUrl);

const ROLES = [
  ['AUDITOR_VERIFICADOR', 'validador'],
  ['RESPONSABLE_PROCESO', 'responsable'],
  ['ASIGNADOR', 'asignador'],
  ['GESTOR_NOVEDADES', 'novedades'],
  ['ANALISTA', 'analista'],
  ['CONTROL_INTERNO', 'control'],
] as const;

async function funcionarios(): Promise<{ usuario: string; rol: string; password: string }[]> {
  const salida: { usuario: string; rol: string; password: string }[] = [];
  for (const [rol, sufijo] of ROLES) {
    const usuario = `demo.${sufijo}`;
    const password = generarPasswordTemporal(usuario);
    const hash = await hashPassword(password);
    await pool.query(
      `INSERT INTO usuarios (usuario, nombres, correo, password_hash, debe_cambiar_password)
       VALUES ($1, $2, $3, $4, false)
       ON CONFLICT ((lower(usuario))) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         debe_cambiar_password = false, estado = 'ACTIVO', intentos_fallidos = 0, bloqueado_hasta = NULL`,
      [usuario, `Demo ${sufijo}`, `${usuario}@alcaldia.test`, hash],
    );
    await pool.query(
      `INSERT INTO usuario_rol (usuario_id, rol_id)
       SELECT u.id, r.id FROM usuarios u, roles r WHERE lower(u.usuario) = $1 AND r.codigo = $2
       ON CONFLICT (usuario_id) DO UPDATE SET rol_id = EXCLUDED.rol_id`,
      [usuario, rol],
    );
    salida.push({ usuario, rol, password });
  }
  return salida;
}

// ---------------------------------------------------------------------------------------------------------
// Solicitudes por la API pública
// ---------------------------------------------------------------------------------------------------------

const NOMBRES = [
  'Luz Marina Barrios',
  'Jorge Eliécer Polo',
  'Rosa Elena Castillo',
  'Carlos Arturo Mendoza',
  'Yolanda Pérez Ortiz',
  'Pedro Pablo De la Hoz',
  'Martha Cecilia Rojas',
  'Álvaro Luis Fontalvo',
];

async function json<T>(r: Response): Promise<T> {
  const t = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${r.url}: ${t}`);
  return JSON.parse(t) as T;
}

const tokenDeCorreo = async (destinatario: string, ruta: string): Promise<string> => {
  const r = await pool.query<{ cuerpo: string }>(
    `SELECT cuerpo FROM correos WHERE destinatario = $1 AND cuerpo LIKE $2 ORDER BY id DESC LIMIT 1`,
    [destinatario, `%${ruta}?token=%`],
  );
  const m = /token=([A-Za-z0-9_-]+)/.exec(r.rows[0]?.cuerpo ?? '');
  if (!m) throw new Error(`No se encontró el enlace ${ruta} del correo de ${destinatario}`);
  return m[1] as string;
};

const pdf = (texto: string) =>
  Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n% ${texto}\n%%EOF\n`);

async function crearSolicitud(i: number): Promise<{ texto: string; radicado: string }> {
  const f = await json<{
    tiposIdentificacion: { id: number; codigo: string }[];
    localidades: { id: number }[];
    barrios: { id: number; localidadId: number }[];
    autorizacion: { version: number };
    formularioToken: string;
  }>(await fetch(`${API}/publico/preinscripcion/formulario`));
  const cc = f.tiposIdentificacion.find((t) => t.codigo === 'CC')!.id;
  const nombre = NOMBRES[i % NOMBRES.length] as string;
  const numero = String(60_000_000 + randomInt(9_000_000));
  const correo = `demo.${numero}@example.com`;
  const localidad = f.localidades[i % f.localidades.length]!;
  const barrio = f.barrios.find((b) => b.localidadId === localidad.id);
  // La protección contra robots exige unos segundos entre abrir el formulario y enviarlo.
  await new Promise((r) => setTimeout(r, 3500));
  await json(
    await fetch(`${API}/publico/preinscripciones`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pcdNombre: nombre,
        pcdTipoIdentificacionId: cc,
        pcdNumero: numero,
        cuidadorNombre: `Cuidador de ${nombre.split(' ')[0]}`,
        cuidadorTipoIdentificacionId: cc,
        cuidadorNumero: String(Number(numero) + 1),
        direccion: `Calle ${40 + i} # ${20 + i} - ${10 + i}`,
        localidadId: localidad.id,
        barrioId: barrio?.id ?? null,
        correo,
        correoConfirmacion: correo,
        aceptaAutorizacion: true,
        autorizacionVersion: f.autorizacion.version,
        formularioToken: f.formularioToken,
        contactoAlterno: '',
      }),
    }),
  );
  // El correo sale por la bandeja de salida: se espera a que quede registrado el de verificación.
  await new Promise((r) => setTimeout(r, 500));
  await json(
    await fetch(`${API}/publico/preinscripciones/verificar-correo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await tokenDeCorreo(correo, '/verificar-correo') }),
    }),
  );
  await new Promise((r) => setTimeout(r, 500));
  const sesion = await json<{ token: string }>(
    await fetch(`${API}/publico/consulta/enlace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await tokenDeCorreo(correo, '/consulta') }),
    }),
  );
  const auth = { Authorization: `Bearer ${sesion.token}` };
  const c = await json<{
    version: number;
    catalogos: Record<string, { id: number; codigo: string }[]>;
  }>(await fetch(`${API}/publico/caracterizacion`, { headers: auth }));
  const id = (lista: string, codigo: string) =>
    c.catalogos[lista]!.find((x) => x.codigo === codigo)!.id;
  await json(
    await fetch(`${API}/publico/caracterizacion`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        version: c.version,
        generoId: id('generos', i % 2 === 0 ? 'FEMENINO' : 'MASCULINO'),
        celular: `31${randomInt(10_000_000, 99_999_999)}`,
        fechaNacimiento: `19${50 + (i % 40)}-0${1 + (i % 9)}-1${i % 9}`,
        ocupacionId: id('ocupaciones', 'DESEMPLEADO'),
        epsId: id('eps', 'SANITAS'),
        embarazo: i % 2 === 0 ? 'NO' : 'NO_APLICA',
        recibeSubsidios: false,
        tipoTransporteId: c.catalogos['tiposTransporte']?.[i % 2]?.id ?? null,
        requiereCuidador: true,
        cuidadorGeneroId: id('generos', 'MASCULINO'),
        cuidadorCelular: '3109876543',
        cuidadorCorreo: 'cuidador@example.com',
      }),
    }),
  );
  const docs = await json<{ documentos: { id: number; codigo: string; obligatorio: boolean }[] }>(
    await fetch(`${API}/publico/caracterizacion/documentos`, { headers: auth }),
  );
  for (const d of docs.documentos.filter((x) => x.obligatorio)) {
    const form = new FormData();
    form.append(
      'archivo',
      new Blob([pdf(d.codigo)], { type: 'application/pdf' }),
      `${d.codigo}.pdf`,
    );
    await json(
      await fetch(`${API}/publico/caracterizacion/documentos/${d.id}`, {
        method: 'POST',
        headers: auth,
        body: form,
      }),
    );
  }
  const rad = await json<{ radicado: string }>(
    await fetch(`${API}/publico/caracterizacion/radicar`, { method: 'POST', headers: auth }),
  );
  return { texto: `${rad.radicado} · ${nombre}`, radicado: rad.radicado };
}

/** El validador abre el caso, da por cumplidos los requisitos, registra los datos de priorización y aprueba. */
async function validarSolicitud(radicado: string, token: string, i: number): Promise<void> {
  const auth = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const fila = (
    await pool.query<{ id: number }>(`SELECT id FROM solicitudes WHERE radicado = $1`, [radicado])
  ).rows[0];
  if (!fila) throw new Error(`No se encontró ${radicado}`);
  const base = `${API}/admin/validacion/casos/${fila.id}`;
  const caso = await json<{
    items: { id: number }[];
    priorizacion: { variables: { codigo: string; opciones: { codigo: string }[] }[] };
  }>(await fetch(`${base}/tomar`, { method: 'POST', headers: auth, body: '{}' }));
  for (const item of caso.items) {
    await json(
      await fetch(`${base}/items/${item.id}`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({
          resultado: 'CUMPLE',
          fuente: 'Consulta de demostración',
          observacion: '',
          evidencia: '',
        }),
      }),
    );
  }
  for (const [k, v] of caso.priorizacion.variables.entries()) {
    const opcion = v.opciones[(i + k) % v.opciones.length] as { codigo: string };
    await json(
      await fetch(`${base}/variables/${v.codigo}`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ valor: opcion.codigo }),
      }),
    );
  }
  await json(
    await fetch(`${base}/decision`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ decision: 'APROBAR', motivacion: '' }),
    }),
  );
}

async function entrarComo(usuario: string, password: string): Promise<string> {
  const r = await json<{ token: string }>(
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'estimulo-portal' },
      body: JSON.stringify({ usuario, password }),
    }),
  );
  return r.token;
}

try {
  await runMigrations(pool);
  const f = await funcionarios();
  console.log('\nFuncionarios de demostración (la contraseña cambia en cada ejecución):\n');
  for (const x of f) console.log(`  ${x.usuario.padEnd(20)} ${x.rol.padEnd(22)} ${x.password}`);
  console.log(`\nCreando ${cantidad} solicitud(es) radicada(s)...`);
  const nuevas: string[] = [];
  for (let i = 0; i < cantidad; i++) {
    try {
      const r = await crearSolicitud(i);
      nuevas.push(r.radicado);
      console.log('  ✓', r.texto);
    } catch (e) {
      console.error('  ✗', (e as Error).message);
    }
  }
  if (validar && nuevas.length > 0) {
    console.log(`\nValidando ${nuevas.length} solicitud(es) como demo.validador...`);
    const v = f.find((x) => x.usuario === 'demo.validador');
    const token = await entrarComo('demo.validador', v?.password ?? '');
    for (const [i, radicado] of nuevas.entries()) {
      try {
        await validarSolicitud(radicado, token, i);
        console.log('  ✓ validada', radicado);
      } catch (e) {
        console.error('  ✗', radicado, (e as Error).message);
      }
    }
  }
  console.log('\nListo. Ingrese al portal interno con cualquiera de los usuarios de arriba.');
} finally {
  await pool.end();
}
