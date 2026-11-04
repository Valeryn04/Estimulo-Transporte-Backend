import type { Express } from 'express';
import request from 'supertest';
import { TurnstileDesactivado } from '../src/infrastructure/security/turnstile.js';
import { loadEnv } from '../src/config/env.js';
import type { Dependencias } from '../src/application/contexto.js';
import { createPool, type Pool } from '../src/infrastructure/db/pool.js';
import { MemoryMailer } from '../src/infrastructure/mail/mailer.js';
import { runMigrations } from '../src/infrastructure/db/migrator.js';
import { hashPassword } from '../src/infrastructure/security/passwords.js';
import { TokenService } from '../src/infrastructure/security/tokens.js';
import { crearAplicacion } from '../src/presentation/http/app.js';
import { CABECERA_PORTAL } from '../src/presentation/http/cookies.js';
import type { Servicios } from '../src/container.js';

export const PASSWORD_PRUEBA = 'Prueba#2026seg';

export interface Entorno {
  app: Express;
  deps: Dependencias;
  servicios: Servicios;
  pool: Pool;
  mailer: MemoryMailer;
  /** Reloj controlable: cambiar `reloj.ahora` adelanta el tiempo de la aplicación. */
  reloj: { ahora: Date };
  cerrar: () => Promise<void>;
}

/** Crea una aplicación completa sobre una base de datos de pruebas vacía y recién migrada. */
export async function crearEntorno(opciones: { ips?: string[] } = {}): Promise<Entorno> {
  const env = loadEnv({ ...process.env, INTERNAL_ALLOWED_IPS: (opciones.ips ?? []).join(',') });
  if (!/test/i.test(env.databaseUrl)) {
    throw new Error(
      'Las pruebas solo pueden ejecutarse contra una base de datos cuyo nombre contenga "test"',
    );
  }
  const pool = createPool(env.databaseUrl);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
  const reloj = { ahora: new Date() };
  const mailer = new MemoryMailer();
  const deps: Dependencias = {
    env,
    pool,
    mailer,
    tokens: new TokenService(env.jwtSecret),
    turnstile: new TurnstileDesactivado(),
    ahora: () => reloj.ahora,
  };
  const { app, servicios } = crearAplicacion(deps, { limitarIntentos: false });
  return {
    app,
    deps,
    servicios,
    pool,
    mailer,
    reloj,
    cerrar: async () => {
      await servicios.correos.esperarDespachos();
      await pool.end();
    },
  };
}

export interface CuentaPrueba {
  id: number;
  usuario: string;
  password: string;
  token: string;
  /** Cookie del refresh token, lista para enviarse a /auth/refresh. */
  cookie: string;
}

let contador = 0;

/** Crea un usuario con el rol indicado (código) directamente en la base de datos. */
export async function crearUsuarioBD(
  e: Entorno,
  rol: string,
  opciones: { debeCambiar?: boolean; protegido?: boolean; usuario?: string } = {},
): Promise<{ id: number; usuario: string; password: string }> {
  contador += 1;
  const usuario = opciones.usuario ?? `${rol.toLowerCase().replace(/_/g, '')}${contador}`;
  const r = await e.pool.query<{ id: number }>(
    `INSERT INTO usuarios (usuario, nombres, correo, password_hash, debe_cambiar_password, protegido)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      usuario,
      `Funcionario ${usuario}`,
      `${usuario}@alcaldia.test`,
      await hashPassword(PASSWORD_PRUEBA),
      opciones.debeCambiar ?? false,
      opciones.protegido ?? false,
    ],
  );
  const id = (r.rows[0] as { id: number }).id;
  await e.pool.query(
    `INSERT INTO usuario_rol (usuario_id, rol_id) SELECT $1, id FROM roles WHERE codigo = $2`,
    [id, rol],
  );
  return { id, usuario, password: PASSWORD_PRUEBA };
}

/** Crea el usuario e inicia sesión. */
export async function crearCuenta(
  e: Entorno,
  rol: string,
  opciones: { debeCambiar?: boolean; protegido?: boolean } = {},
): Promise<CuentaPrueba> {
  const u = await crearUsuarioBD(e, rol, opciones);
  const login = await request(e.app)
    .post('/api/v1/auth/login')
    .send({ usuario: u.usuario, password: u.password });
  const token = (login.body as { token: string }).token;
  const cookie = ((login.headers['set-cookie'] as unknown as string[] | undefined) ?? [])[0] ?? '';
  return { ...u, token, cookie: cookie.split(';')[0] ?? '' };
}

export const auth = (cuenta: { token: string }) => ({ Authorization: `Bearer ${cuenta.token}` });

/** Cabeceras que el portal agrega a las llamadas que usan la cookie de sesión. */
export const desdePortal = { 'X-Requested-With': CABECERA_PORTAL };

/**
 * Deja un caso asignado a una persona directamente en la base de datos (la API solo asigna a validadores que no son
 * administradores). Sirve para que las pruebas puedan «tomar» un caso sin repetir el reparto en cada una.
 */
export async function asignarEnBd(e: Entorno, solicitudId: number, usuarioId: number) {
  await e.pool.query(
    `INSERT INTO validaciones (solicitud_id, asignado_a, asignado_por, asignado_at)
     VALUES ($1, $2, $2, now())
     ON CONFLICT (solicitud_id) DO UPDATE SET asignado_a = $2, asignado_por = $2, asignado_at = now()`,
    [solicitudId, usuarioId],
  );
}

/** Igual que `asignarEnBd`, pero a partir del token de acceso de la persona. */
export async function asignarAlToken(e: Entorno, solicitudId: number, token: string) {
  const yo = await request(e.app)
    .get('/api/v1/auth/me')
    .set({ Authorization: `Bearer ${token}` });
  await asignarEnBd(e, solicitudId, yo.body.id as number);
}

/** PDF real con el número de hojas indicado (los documentos de varias hojas se validan contando sus páginas). */
export async function pdfConHojas(n: number): Promise<Buffer> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage();
  return Buffer.from(await doc.save());
}
