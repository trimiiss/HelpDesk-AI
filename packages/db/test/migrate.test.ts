import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@helpdesk/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate, type Pool } from '../src/index.js';

const url = process.env.TEST_DATABASE_URL;
const log = createLogger('test', 'silent');

describe.runIf(url)('migrate', () => {
  let pool: Pool;
  let directory: string;

  beforeAll(() => {
    pool = createPool(url ?? '');
  });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'migrations-'));
    await pool.query(`DELETE FROM schema_migrations WHERE filename LIKE 'test_%'`).catch(() => {});
    await pool.query('DROP TABLE IF EXISTS migrate_test');
  });

  afterEach(async () => {
    rmSync(directory, { recursive: true, force: true });
    await pool.query(`DELETE FROM schema_migrations WHERE filename LIKE 'test_%'`);
    await pool.query('DROP TABLE IF EXISTS migrate_test');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applies files in order and only once', async () => {
    writeFileSync(join(directory, 'test_002.sql'), 'ALTER TABLE migrate_test ADD COLUMN b INT;');
    writeFileSync(join(directory, 'test_001.sql'), 'CREATE TABLE migrate_test (a INT);');

    expect(await migrate(pool, directory, log)).toEqual(['test_001.sql', 'test_002.sql']);
    expect(await migrate(pool, directory, log)).toEqual([]);
  });

  it('rolls back a failed file completely', async () => {
    writeFileSync(
      join(directory, 'test_001.sql'),
      'CREATE TABLE migrate_test (a INT); SELECT * FROM no_such_table;',
    );

    await expect(migrate(pool, directory, log)).rejects.toThrow('test_001.sql');

    const { rows } = await pool.query(`SELECT to_regclass('migrate_test') AS found`);
    expect(rows[0]).toEqual({ found: null });
  });

  it('is safe when several pods start at once', async () => {
    writeFileSync(join(directory, 'test_001.sql'), 'CREATE TABLE migrate_test (a INT);');

    const results = await Promise.all([
      migrate(pool, directory, log),
      migrate(pool, directory, log),
      migrate(pool, directory, log),
    ]);

    expect(results.flat()).toEqual(['test_001.sql']);
  });
});
