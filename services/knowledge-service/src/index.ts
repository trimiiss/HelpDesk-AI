import { createPool } from '@helpdesk/db';
import { createLocalEmbedder, createOpenAIEmbedder, KnowledgeStore } from '@helpdesk/knowledge';
import {
  createLogger,
  createMetricsRegistry,
  initTelemetry,
  startMetricsServer,
} from '@helpdesk/shared';
import { loadConfig } from './config.js';
import { buildServer } from './server.js';

const config = loadConfig();
const log = createLogger('knowledge-service', config.LOG_LEVEL);
const telemetry = initTelemetry('knowledge-service', config.OTEL_EXPORTER_OTLP_ENDPOINT);
const registry = createMetricsRegistry('knowledge-service');
const pool = createPool(config.DATABASE_URL);

const embedder =
  config.EMBEDDING_PROVIDER === 'local'
    ? createLocalEmbedder()
    : createOpenAIEmbedder({
        apiKey: config.OPENAI_API_KEY ?? '',
        model: config.EMBEDDING_MODEL,
        baseUrl: config.OPENAI_BASE_URL,
        timeoutMs: config.EMBEDDING_TIMEOUT_MS,
      });

const app = buildServer({
  store: new KnowledgeStore(pool),
  embedder,
  minSimilarity: config.SEARCH_MIN_SIMILARITY,
  defaultTopK: config.SEARCH_TOP_K,
  registry,
  log,
});

const metricsServer = startMetricsServer(registry, config.METRICS_PORT);

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await app.close();
  metricsServer.close();
  await pool.end();
  await telemetry.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: '0.0.0.0', port: config.PORT });
log.info({ port: config.PORT, embeddingModel: embedder.model }, 'knowledge-service listening');
