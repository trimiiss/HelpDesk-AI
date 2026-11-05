import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@helpdesk/shared': source('shared'),
      '@helpdesk/broker': source('broker'),
      '@helpdesk/db': source('db'),
      '@helpdesk/knowledge': source('knowledge'),
    },
  },
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'services/*/test/**/*.test.ts',
      'tools/*/test/**/*.test.ts',
    ],
    // Integration tests share one database, so files must not run at the same time.
    fileParallelism: !process.env.TEST_DATABASE_URL,
  },
});
