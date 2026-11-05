import { parseEnv } from '@helpdesk/shared';
import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8081),
    METRICS_PORT: z.coerce.number().int().positive().default(9464),
    LOG_LEVEL: z.string().default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    DATABASE_URL: z.string().min(1),

    // Use "local" only for the simulation: it matches on spelling, not meaning.
    EMBEDDING_PROVIDER: z.enum(['openai', 'local']).default('openai'),
    EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
    OPENAI_API_KEY: z.string().min(1).optional(),
    OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
    EMBEDDING_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),

    // The most relevant chunk must reach this similarity, or nothing is returned.
    // Tune it with `npm run eval:rag`.
    SEARCH_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
    SEARCH_TOP_K: z.coerce.number().int().min(1).max(10).default(4),
  })
  .refine((config) => config.EMBEDDING_PROVIDER === 'local' || config.OPENAI_API_KEY, {
    path: ['OPENAI_API_KEY'],
    message: 'is required when EMBEDDING_PROVIDER is openai',
  });

export type KnowledgeConfig = z.output<typeof schema>;

export const loadConfig = (env?: Record<string, string | undefined>): KnowledgeConfig =>
  parseEnv(schema, env);
