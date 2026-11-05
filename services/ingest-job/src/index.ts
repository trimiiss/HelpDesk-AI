import { createPool } from '@helpdesk/db';
import { createLocalEmbedder, createOpenAIEmbedder, KnowledgeStore } from '@helpdesk/knowledge';
import { createLogger, parseEnv } from '@helpdesk/shared';
import { z } from 'zod';
import { runIngest } from './ingest.js';

const schema = z
  .object({
    LOG_LEVEL: z.string().default('info'),
    DATABASE_URL: z.string().min(1),
    KNOWLEDGE_DIR: z.string().default('/knowledge'),
    EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),
    EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  })
  .refine((config) => config.EMBEDDING_PROVIDER === 'local' || config.OPENAI_API_KEY, {
    path: ['OPENAI_API_KEY'],
    message: 'is required when EMBEDDING_PROVIDER is openai',
  });

const config = parseEnv(schema);
const log = createLogger('ingest-job', config.LOG_LEVEL);
const pool = createPool(config.DATABASE_URL, 2);

const embedder =
  config.EMBEDDING_PROVIDER === 'local'
    ? createLocalEmbedder()
    : createOpenAIEmbedder({
        apiKey: config.OPENAI_API_KEY ?? '',
        model: config.EMBEDDING_MODEL,
        baseUrl: config.OPENAI_BASE_URL,
        timeoutMs: 60_000,
        maxAttempts: 5,
      });

try {
  const result = await runIngest(config.KNOWLEDGE_DIR, new KnowledgeStore(pool), embedder, log);
  log.info(result, 'ingest finished');
} catch (error) {
  log.fatal({ err: error }, 'ingest failed, the live index was not changed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
