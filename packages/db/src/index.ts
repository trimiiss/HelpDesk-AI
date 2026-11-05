import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@helpdesk/shared';
import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPool(connectionString: string, max = 10): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000 });
  // An idle client losing its connection must not crash the process.
  pool.on('error', () => {});
  return pool;
}

/** An arbitrary constant. Only one migrator may run at a time. */
const MIGRATION_LOCK = 8_352_001;

/**
 * Applies any .sql files not yet recorded, in filename order, one transaction
 * each. Several pods can start at once, so an advisory lock lets one do the work
 * while the others wait and then find nothing to do.
 */
export async function migrate(pool: pg.Pool, directory: string, log: Logger): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations',
    );
    const done = new Set(rows.map((row) => row.filename));
    const files = readdirSync(directory)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    for (const file of files) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(join(directory, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log.info({ file }, 'applied migration');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${String(error)}`, { cause: error });
      }
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}
