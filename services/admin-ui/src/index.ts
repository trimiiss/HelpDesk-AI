import { createPool } from '@helpdesk/db';
import { createLogger, parseEnv } from '@helpdesk/shared';
import { z } from 'zod';
import { AdminQueries } from './queries.js';
import { buildServer } from './server.js';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(8082),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().startsWith('scrypt:', 'create one with npm run admin:hash'),
  ADMIN_SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ADMIN_COOKIE_SECURE: z.stringbool().default(true),
  JAEGER_UI_URL: z.string().optional(),
});

const config = parseEnv(schema);
const log = createLogger('admin-ui', config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, 5);

const app = buildServer({
  queries: new AdminQueries(pool),
  passwordHash: config.ADMIN_PASSWORD_HASH,
  sessionSecret: config.ADMIN_SESSION_SECRET,
  secureCookies: config.ADMIN_COOKIE_SECURE,
  jaegerUrl: config.JAEGER_UI_URL,
  log,
});

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
log.info({ port: config.PORT }, 'admin-ui listening');
