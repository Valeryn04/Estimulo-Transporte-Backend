import { pino } from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : (process.env.LOG_LEVEL ?? 'info'),
  // Nunca registrar credenciales ni datos de autenticación.
  redact: ['req.headers.authorization', 'password', '*.password', 'token', '*.token'],
});
