import { BufferedPublisher, NatsEventBus } from '@helpdesk/broker';
import {
  createLogger,
  createMetricsRegistry,
  initTelemetry,
  startMetricsServer,
} from '@helpdesk/shared';
import { loadBusinessConfig } from './business.js';
import { createCallControl } from './callControl.js';
import { loadConfig } from './config.js';
import { createKnowledgeClient } from './knowledgeClient.js';
import { createCallMetrics } from './metrics.js';
import { buildInstructions } from './prompt.js';
import { createRealtimeConnector } from './realtime.js';
import { buildServer } from './server.js';
import { buildSessionUpdate } from './session.js';
import { createCostEstimator, loadPricing } from './usage.js';

const config = loadConfig();
const log = createLogger('call-gateway', config.LOG_LEVEL);
const telemetry = initTelemetry('call-gateway', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const registry = createMetricsRegistry('call-gateway');
const metrics = createCallMetrics(registry);
const metricsServer = startMetricsServer(registry, config.METRICS_PORT);

const business = loadBusinessConfig(config.BUSINESS_CONFIG_PATH);
const pricing = loadPricing(config.PRICING_CONFIG_PATH);
const transferAvailable = config.TRANSFER_NUMBER !== undefined;

if (!transferAvailable) {
  log.warn('TRANSFER_NUMBER is not set: transfers are off and a failed call will hang up');
}
if (!pricing.models[config.REALTIME_MODEL]) {
  log.warn({ model: config.REALTIME_MODEL }, 'no rates in pricing.yaml: call costs will show as 0');
}

const bus = new NatsEventBus({ url: config.NATS_URL, log });
const events = new BufferedPublisher({
  bus,
  log,
  onDrop: () => metrics.eventDropped(),
  onDepthChange: (depth) => metrics.queueDepth(depth),
});

const server = buildServer({
  config,
  log,
  sessionUpdate: buildSessionUpdate(config, buildInstructions(business, { transferAvailable })),
  connectRealtime: createRealtimeConnector({
    url: config.OPENAI_REALTIME_URL,
    model: config.REALTIME_MODEL,
    apiKey: config.OPENAI_API_KEY,
    log,
  }),
  control: createCallControl({
    accountSid: config.TWILIO_ACCOUNT_SID,
    authToken: config.TWILIO_AUTH_TOKEN,
    apiBaseUrl: config.TWILIO_API_BASE_URL,
    transferNumber: config.TRANSFER_NUMBER,
  }),
  events,
  searchKnowledge: createKnowledgeClient({
    baseUrl: config.KNOWLEDGE_SERVICE_URL,
    timeoutMs: config.KNOWLEDGE_TIMEOUT_MS,
  }),
  metrics,
  estimateCost: createCostEstimator(pricing, config.REALTIME_MODEL, config.TRANSCRIPTION_MODEL),
});

const { app, mediaStream } = server;
let shuttingDown = false;

/**
 * Lets active calls finish before the process exits. Readiness fails first, so
 * the load balancer stops sending new calls here, and only once the last call
 * ends, or the time runs out, do the sockets close. Kubernetes allows for this
 * with a termination grace period longer than the longest possible call.
 */
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal, activeCalls: mediaStream.activeCalls() }, 'draining');
  server.startDraining();

  const deadline = Date.now() + (config.MAX_CALL_SECONDS + 30) * 1000;
  while (mediaStream.activeCalls() > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  mediaStream.shutdown();
  await events.flush(5000);
  await app.close();
  await bus.close();
  metricsServer.close();
  await telemetry.shutdown();
  log.info('shut down cleanly');
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
log.info(
  { port: config.PORT, model: config.REALTIME_MODEL, publicUrl: config.PUBLIC_BASE_URL },
  'call-gateway listening',
);
