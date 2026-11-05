import { NatsEventBus } from '@helpdesk/broker';
import { createPool } from '@helpdesk/db';
import {
  createLogger,
  createMetricsRegistry,
  initTelemetry,
  startMetricsServer,
} from '@helpdesk/shared';
import { loadConfig } from './config.js';
import { createEventHandler, createWorkerMetrics } from './handler.js';
import { createEmailNotifier } from './notifier.js';
import { CallStore } from './store.js';

const RETRY_BACKOFF_MS = [1000, 5000, 30_000, 60_000];

const config = loadConfig();
const log = createLogger('call-worker', config.LOG_LEVEL);
const telemetry = initTelemetry('call-worker', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const registry = createMetricsRegistry('call-worker');
const metrics = createWorkerMetrics(registry);
const metricsServer = startMetricsServer(registry, config.METRICS_PORT);

const pool = createPool(config.DATABASE_URL);
const bus = new NatsEventBus({
  url: config.NATS_URL,
  log,
  onDeadLetter: () => metrics.deadLetters.inc(),
});

const subscription = await bus.subscribe(
  createEventHandler({
    store: new CallStore(pool),
    notifier: createEmailNotifier({
      smtpUrl: config.SMTP_URL,
      from: config.NOTIFY_EMAIL_FROM,
      to: config.NOTIFY_EMAIL_TO,
    }),
    metrics,
    log,
  }),
  { durableName: 'call-worker', maxAttempts: config.MAX_ATTEMPTS, backoffMs: RETRY_BACKOFF_MS },
);

log.info('call-worker consuming events');

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await subscription.stop();
  await bus.close();
  await pool.end();
  metricsServer.close();
  await telemetry.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
