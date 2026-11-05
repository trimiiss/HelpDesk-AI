import { Counter, Histogram, traceRequests, withSpan, type Logger, type Registry } from '@helpdesk/shared';
import { toVectorLiteral, type Embedder, type KnowledgeStore } from '@helpdesk/knowledge';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

const searchRequest = z.object({
  query: z.string().trim().min(1).max(500),
  topK: z.number().int().min(1).max(10).optional(),
});

export interface SearchResponse {
  found: boolean;
  results: { text: string; source: string; score: number }[];
}

export interface ServerDeps {
  store: Pick<KnowledgeStore, 'search' | 'activeGeneration'>;
  embedder: Embedder;
  minSimilarity: number;
  defaultTopK: number;
  registry: Registry;
  log: Logger;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { store, embedder, log } = deps;
  const app = Fastify();
  traceRequests(app);

  const requests = new Counter({
    name: 'helpdesk_search_requests_total',
    help: 'Knowledge searches by outcome.',
    labelNames: ['outcome'],
    registers: [deps.registry],
  });
  const duration = new Histogram({
    name: 'helpdesk_search_duration_seconds',
    help: 'Time to answer a knowledge search.',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
    registers: [deps.registry],
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  // Ready means search can work: the database answers and an index has been built.
  app.get('/readyz', async (_request, reply) => {
    try {
      const generation = await store.activeGeneration();
      if (!generation) return reply.code(503).send({ status: 'no knowledge indexed yet' });
      if (generation.embeddingModel !== embedder.model) {
        return reply.code(503).send({ status: 'index was built with a different embedding model' });
      }
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'database unavailable' });
    }
  });

  app.post('/search', async (request, reply) => {
    const parsed = searchRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'query is required' });

    const stop = duration.startTimer();
    const { query, topK = deps.defaultTopK } = parsed.data;

    try {
      const [vector] = await withSpan('embed query', {}, () => embedder.embed([query]));
      if (!vector) throw new Error('no embedding returned');

      const hits = await withSpan('search chunks', {}, () =>
        store.search(toVectorLiteral(vector), query, topK),
      );

      // Rank scores always give a "best" result, however poor. Similarity is what
      // tells us if it has anything to do with the question.
      const best = Math.max(0, ...hits.map((hit) => hit.similarity));
      const found = best >= deps.minSimilarity;
      requests.inc({ outcome: found ? 'found' : 'not_found' });

      const response: SearchResponse = {
        found,
        results: found
          ? hits.map(({ text, source, similarity }) => ({ text, source, score: similarity }))
          : [],
      };
      return response;
    } catch (error) {
      requests.inc({ outcome: 'error' });
      log.error({ err: error }, 'search failed');
      return reply.code(502).send({ error: 'search failed' });
    } finally {
      stop();
    }
  });

  return app;
}
