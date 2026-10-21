import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3100),
  // Una o varias direcciones del frontend separadas por coma (la primera se usa en los enlaces de los correos).
  FRONTEND_URL: z
    .string()
    .refine((v) => v.split(',').every((u) => z.string().url().safeParse(u.trim()).success), {
      message: 'FRONTEND_URL debe ser una URL (o varias separadas por coma)',
    }),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  DATA_ENCRYPTION_KEYS: z.string().min(1),
  STORAGE_DIR: z.string().min(1).default('./uploads'),
  // Conexiones máximas a PostgreSQL por instancia de la API (ajústelo según el servidor y las instancias).
  DB_POOL_MAX: z.coerce.number().int().min(2).max(200).default(20),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1026),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  // Nombre con el que se valida el certificado TLS cuando difiere del host (Brevo: smtp-relay.sendinblue.com).
  SMTP_TLS_SERVERNAME: z.string().default(''),
  MAIL_FROM: z.string().min(3),
  // Secreto compartido con el proveedor de correo para reportar entregas y rebotes (RNF-13).
  MAIL_WEBHOOK_SECRET: z.string().min(16),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  INTERNAL_ALLOWED_IPS: z.string().default(''),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  API_DOCS: z.enum(['true', 'false']).optional(),
  // Cloudflare Turnstile: con ambas llaves se exige la verificación en los formularios públicos y el inicio de sesión.
  TURNSTILE_SITE_KEY: z.string().default(''),
  TURNSTILE_SECRET: z.string().default(''),
});

export interface EncryptionKeys {
  activeId: string;
  keys: Map<string, Buffer>;
}

export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  frontendUrl: string;
  /** Orígenes del frontend admitidos por CORS. */
  frontendOrigenes: string[];
  databaseUrl: string;
  jwtSecret: string;
  encryption: EncryptionKeys;
  storageDir: string;
  dbPoolMax: number;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    tlsServername: string;
  };
  mailFrom: string;
  mailWebhookSecret: string;
  trustProxy: number;
  /** IP o rangos CIDR desde los que se admite el portal interno. Vacío = sin restricción. */
  internalAllowedIps: string[];
  /** La cookie del refresh token solo viaja por HTTPS. Obligatorio en producción. */
  cookieSecure: boolean;
  /** Publica la documentación OpenAPI en /api/docs. Por defecto, solo fuera de producción. */
  apiDocs: boolean;
  /** Llaves de Cloudflare Turnstile; null = verificación desactivada. */
  turnstile: { siteKey: string; secret: string } | null;
}

/** Interpreta "v1:base64,v2:base64": la primera llave es la activa. */
export function parseEncryptionKeys(raw: string): EncryptionKeys {
  const keys = new Map<string, Buffer>();
  let activeId = '';
  for (const part of raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const [id, b64] = part.split(':');
    if (!id || !b64) throw new Error('DATA_ENCRYPTION_KEYS: formato inválido (use id:base64)');
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) {
      throw new Error(`DATA_ENCRYPTION_KEYS: la llave ${id} debe tener 32 bytes`);
    }
    keys.set(id, key);
    if (!activeId) activeId = id;
  }
  if (!activeId) throw new Error('DATA_ENCRYPTION_KEYS: no hay llaves definidas');
  return { activeId, keys };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuración de entorno inválida:\n${detalle}`);
  }
  const e = parsed.data;
  const frontendOrigenes = e.FRONTEND_URL.split(',').map((u) => u.trim().replace(/\/$/, ''));
  const cookieSecure = e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : e.NODE_ENV === 'production';
  if (e.NODE_ENV === 'production' && !cookieSecure) {
    throw new Error(
      'COOKIE_SECURE no puede ser false en producción: la sesión debe viajar por HTTPS',
    );
  }
  return {
    turnstile:
      e.TURNSTILE_SITE_KEY && e.TURNSTILE_SECRET
        ? { siteKey: e.TURNSTILE_SITE_KEY, secret: e.TURNSTILE_SECRET }
        : null,
    apiDocs: e.API_DOCS ? e.API_DOCS === 'true' : e.NODE_ENV !== 'production',
    cookieSecure,
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    frontendUrl: frontendOrigenes[0]!,
    frontendOrigenes,
    databaseUrl: e.DATABASE_URL,
    jwtSecret: e.JWT_SECRET,
    encryption: parseEncryptionKeys(e.DATA_ENCRYPTION_KEYS),
    storageDir: e.STORAGE_DIR,
    dbPoolMax: e.DB_POOL_MAX,
    smtp: {
      host: e.SMTP_HOST,
      port: e.SMTP_PORT,
      secure: e.SMTP_SECURE,
      user: e.SMTP_USER,
      pass: e.SMTP_PASS,
      tlsServername: e.SMTP_TLS_SERVERNAME,
    },
    mailFrom: e.MAIL_FROM,
    mailWebhookSecret: e.MAIL_WEBHOOK_SECRET,
    trustProxy: e.TRUST_PROXY,
    internalAllowedIps: e.INTERNAL_ALLOWED_IPS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
