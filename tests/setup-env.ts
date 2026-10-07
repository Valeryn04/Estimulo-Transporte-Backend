import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import 'dotenv/config';

// Las pruebas SIEMPRE usan la base de datos de pruebas, nunca la de desarrollo.
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_URL ??=
  'postgres://estimulo_app:estimulo_app@localhost:5432/estimulo_transporte_test';
// Siempre la misma dirección en las pruebas, sin depender de lo que tenga el .env de cada equipo (por ejemplo, una IP de red).
process.env.FRONTEND_URL = 'http://localhost:4300';
process.env.JWT_SECRET ??= randomBytes(32).toString('base64url');
process.env.DATA_ENCRYPTION_KEYS ??= `v1:${randomBytes(32).toString('base64')}`;
process.env.MAIL_FROM ??= 'Estímulo <no-responder@estimulo.test>';
process.env.MAIL_WEBHOOK_SECRET = 'secreto-de-prueba-del-webhook';
process.env.INTERNAL_ALLOWED_IPS = '';
process.env.STORAGE_DIR = mkdtempSync(path.join(tmpdir(), 'estimulo-uploads-'));
