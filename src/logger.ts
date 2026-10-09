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
  // x-goog-api-key at any depth (e.g. if a future `fetch init` debug line
  // accidentally logs a native-Gemini request). Belt-and-braces.
  '*.x-goog-api-key',
  '*.X-Goog-Api-Key',
  'adminToken',
  'accountsEncryptionKey',
  'googleOauthClientSecret',
  // Bracket notation for header paths (pino's docs recommend explicit
  // bracket form for header names that contain hyphens).
  'req.headers["authorization"]',
  'req.headers["Authorization"]',
  'req.headers["cookie"]',
  'req.headers["Cookie"]',
  'req.headers["x-goog-api-key"]',
  'req.headers["X-Goog-Api-Key"]',
  'config.geminiApiKeys',
  // Belt-and-braces: a future debug line that writes `keySuffix: ...` or
  // `*.keySuffix` must not leak the last 4 chars of an AIza key. The
  // preferred path is to log `keyId` (8 hex of SHA-256) instead — but
  // if a contributor adds the suffix back, the redact list catches it.
  '*.keySuffix',
  '*.keySuffix.*',
  'keySuffix',
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
