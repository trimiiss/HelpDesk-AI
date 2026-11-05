import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(service: string, level = 'info'): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/** Keeps phone numbers recognisable in logs without storing them in full. */
export function maskPhone(phone: string | undefined): string | undefined {
  if (!phone) return undefined;
  return phone.length <= 4 ? '***' : `***${phone.slice(-4)}`;
}
