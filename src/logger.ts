import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'gemini-tunnel' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
