import { createLogger } from '@helpdesk/shared';
import { createPool, migrate } from './index.js';

const log = createLogger('db-migrate');
const url = process.env.DATABASE_URL;

if (!url) {
  log.fatal('DATABASE_URL is not set');
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const applied = await migrate(pool, process.env.MIGRATIONS_DIR ?? 'db/migrations', log);
  log.info({ applied: applied.length }, 'database is up to date');
} catch (error) {
  log.fatal({ err: error }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
