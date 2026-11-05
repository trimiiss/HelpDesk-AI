import { createLocalEmbedder, type SearchHit } from '@helpdesk/knowledge';
import { createLogger, Registry } from '@helpdesk/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildServer, type ServerDeps } from '../src/server.js';

const embedder = createLocalEmbedder();
const hit = (similarity: number, text = 'We open at 8.'): SearchHit => ({
  text,
  source: 'faq.md',
  similarity,
  score: 0.03,
});

function server(hits: SearchHit[], overrides: Partial<ServerDeps> = {}) {
  return buildServer({
    store: {
      search: vi.fn(async () => hits),
      activeGeneration: vi.fn(async () => ({
        id: '1',
        corpusHash: 'x',
        embeddingModel: embedder.model,
      })),
    },
    embedder,
    minSimilarity: 0.4,
    defaultTopK: 4,
    registry: new Registry(),
    log: createLogger('test', 'silent'),
    ...overrides,
  });
}

const search = (app: ReturnType<typeof buildServer>, body: unknown) =>
  app.inject({ method: 'POST', url: '/search', payload: body as object });

describe('POST /search', () => {
  it('returns matches above the similarity threshold', async () => {
    const response = await search(server([hit(0.8)]), { query: 'opening hours' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      found: true,
      results: [{ text: 'We open at 8.', source: 'faq.md', score: 0.8 }],
    });
  });

  it('returns nothing below the threshold, so the agent can say it does not know', async () => {
    const response = await search(server([hit(0.2)]), { query: 'do you sell helicopters' });
    expect(response.json()).toEqual({ found: false, results: [] });
  });

  it('treats an empty index as not found', async () => {
    const response = await search(server([]), { query: 'anything' });
    expect(response.json()).toEqual({ found: false, results: [] });
  });

  it('counts any strong result, not only the first', async () => {
    const response = await search(server([hit(0.1, 'weak'), hit(0.9, 'strong')]), { query: 'q' });
    expect(response.json<{ found: boolean }>().found).toBe(true);
  });

  it.each([
    ['an empty query', { query: '   ' }],
    ['a missing query', {}],
    ['an oversized query', { query: 'x'.repeat(501) }],
    ['a topK out of range', { query: 'q', topK: 100 }],
  ])('rejects %s', async (_name, body) => {
    const response = await search(server([]), body);
    expect(response.statusCode).toBe(400);
  });

  it('fails cleanly when the embedder is down', async () => {
    const app = server([], {
      embedder: {
        model: embedder.model,
        embed: async () => {
          throw new Error('openai is down');
        },
      },
    });
    const response = await search(app, { query: 'hours' });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('openai');
  });

  it('keeps the query out of the error response', async () => {
    const app = server([], {
      store: {
        search: async () => {
          throw new Error('db down');
        },
        activeGeneration: async () => undefined,
      },
    });
    const response = await search(app, { query: 'my-private-question' });
    expect(response.body).not.toContain('my-private-question');
  });
});

describe('readiness', () => {
  const ready = (app: ReturnType<typeof buildServer>) => app.inject({ method: 'GET', url: '/readyz' });

  it('is ready once an index exists', async () => {
    expect((await ready(server([]))).statusCode).toBe(200);
  });

  it('is not ready before anything has been indexed', async () => {
    const app = server([], {
      store: { search: vi.fn(), activeGeneration: async () => undefined },
    });
    expect((await ready(app)).statusCode).toBe(503);
  });

  it('is not ready if the index used a different embedding model', async () => {
    const app = server([], {
      store: {
        search: vi.fn(),
        activeGeneration: async () => ({ id: '1', corpusHash: 'x', embeddingModel: 'other' }),
      },
    });
    expect((await ready(app)).statusCode).toBe(503);
  });

  it('is not ready if the database is down', async () => {
    const app = server([], {
      store: {
        search: vi.fn(),
        activeGeneration: async () => {
          throw new Error('down');
        },
      },
    });
    expect((await ready(app)).statusCode).toBe(503);
  });
});
