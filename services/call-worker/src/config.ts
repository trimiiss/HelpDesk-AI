import { parseEnv } from '@helpdesk/shared';
import { z } from 'zod';

const schema = z.object({
  METRICS_PORT: z.coerce.number().int().positive().default(9464),
  LOG_LEVEL: z.string().default('info'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

  DATABASE_URL: z.string().min(1),
  NATS_URL: z.string().min(1).default('nats://nats:4222'),

  // For example smtp://user:password@smtp.example.com:587
  SMTP_URL: z.string().min(1),
  NOTIFY_EMAIL_TO: z.string().min(1),
  NOTIFY_EMAIL_FROM: z.string().min(1),

  // After this many failed attempts, an event moves to the dead-letter subject.
  MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
});

export type WorkerConfig = z.output<typeof schema>;

export const loadConfig = (env?: Record<string, string | undefined>): WorkerConfig =>
  parseEnv(schema, env);
