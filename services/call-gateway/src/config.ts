import { parseEnv } from '@helpdesk/shared';
import { z } from 'zod';

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, 'must be E.164, for example +38344123456');

const schema = z
  .object({
    PORT: z.coerce.number().int().positive().default(8080),
    METRICS_PORT: z.coerce.number().int().positive().default(9464),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_TRANSCRIPTS: z.stringbool().default(false),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),

    // The URL Twilio calls. Signatures are checked against this value and never
    // against the Host header, which a proxy can change and an attacker can forge.
    PUBLIC_BASE_URL: z
      .string()
      .regex(/^https:\/\/[^/\s]+\/?$/, 'must look like https://example.com')
      .transform((url) => url.replace(/\/$/, '')),

    TWILIO_ACCOUNT_SID: z.string().regex(/^AC[0-9a-fA-F]{32}$/, 'must start with AC'),
    TWILIO_AUTH_TOKEN: z.string().min(1),
    TWILIO_API_BASE_URL: z.string().default('https://api.twilio.com'),
    TRANSFER_NUMBER: e164.optional(),

    OPENAI_API_KEY: z.string().min(1),
    OPENAI_REALTIME_URL: z.string().default('wss://api.openai.com/v1/realtime'),
    REALTIME_MODEL: z.string().min(1).default('gpt-realtime-2.1-mini'),
    REALTIME_VOICE: z.string().min(1).default('marin'),
    REALTIME_REASONING_EFFORT: z
      .enum(['minimal', 'low', 'medium', 'high', 'xhigh'])
      .default('low'),
    TRANSCRIPTION_MODEL: z.string().min(1).default('gpt-transcribe'),

    VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.5),
    VAD_PREFIX_PADDING_MS: z.coerce.number().int().nonnegative().default(300),
    VAD_SILENCE_DURATION_MS: z.coerce.number().int().positive().default(500),

    MAX_CALL_SECONDS: z.coerce.number().int().positive().default(600),
    GOODBYE_LEAD_SECONDS: z.coerce.number().int().positive().default(30),
    SESSION_READY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
    TRANSFER_PLAYBACK_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),

    NATS_URL: z.string().min(1).default('nats://nats:4222'),
    KNOWLEDGE_SERVICE_URL: z.string().min(1).default('http://knowledge-service:8081'),
    KNOWLEDGE_TIMEOUT_MS: z.coerce.number().int().positive().default(2500),
    MESSAGE_SAVE_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),

    BUSINESS_CONFIG_PATH: z.string().min(1).default('config/business.yaml'),
    PRICING_CONFIG_PATH: z.string().min(1).default('config/pricing.yaml'),
  })
  .refine((config) => config.GOODBYE_LEAD_SECONDS < config.MAX_CALL_SECONDS, {
    path: ['GOODBYE_LEAD_SECONDS'],
    message: 'must be shorter than MAX_CALL_SECONDS',
  });

export type GatewayConfig = z.output<typeof schema>;

export function loadConfig(env?: Record<string, string | undefined>): GatewayConfig {
  return parseEnv(schema, env);
}
