import pino from 'pino';
import { config } from './config.js';

// Redact anything that looks like a credential, even if it lands under a
// key name we didn't anticipate. Pino matches these as paths into the
// logged object. The list is intentionally broad (a future `Authorization`
// header dump, an `access_token` field, a `password`, etc.) so a one-off
// debug line that logs the wrong thing fails closed.
const REDACT_PATHS = [
  '*.access_token',
  '*.refresh_token',
  '*.id_token',
  '*.authorization',
  '*.Authorization',
  '*.cookie',
  '*.Cookie',
  '*.password',
  '*.Password',
  'adminToken',
  'accountsEncryptionKey',
  'googleOauthClientSecret',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger = pino({
  level: config.logLevel,
  base: { service: 'gemini-tunnel' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
});

export type Logger = typeof logger;
