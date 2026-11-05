import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalEmbedder, createOpenAIEmbedder, EMBEDDING_DIMENSIONS } from '../src/embedder.js';
import { toKeywordQuery, toVectorLiteral } from '../src/store.js';

const cosine = (a: number[], b: number[]) =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

describe('local embedder', () => {
  const embedder = createLocalEmbedder();
  const embed = async (text: string) => (await embedder.embed([text]))[0] ?? [];

  it('produces vectors of the size the database column expects', async () => {
    expect(await embed('oil change')).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  it('returns unit vectors, so similarity is a plain dot product', async () => {
    expect(Math.hypot(...(await embed('oil change')))).toBeCloseTo(1, 5);
  });

  it('is deterministic', async () => {
    expect(await embed('oil change')).toEqual(await embed('oil change'));
  });

  it('rates related text above unrelated text', async () => {
    const question = await embed('how much is an oil change');
    const related = await embed('oil change price 45 euro');
    const unrelated = await embed('we are closed on public holidays');
    expect(cosine(question, related)).toBeGreaterThan(cosine(question, unrelated));
  });

  it('ignores accents, so ASR output without them still matches', async () => {
    const accented = await embed('çmimi i ndërrimit të vajit');
    const plain = await embed('cmimi i nderrimit te vajit');
    expect(cosine(accented, plain)).toBeGreaterThan(0.99);
  });

  it('survives text with no letters at all', async () => {
    expect(await embed('!!!')).toHaveLength(EMBEDDING_DIMENSIONS);
  });
});

describe('OpenAI embedder', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
  });

  async function fakeOpenAI(respond: (body: { input: string[]; dimensions: number }, attempt: number) => {
    status: number;
    body: unknown;
  }) {
    let attempt = 0;
    const requests: { authorization?: string; body: unknown }[] = [];

    server = createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => (data += chunk));
      request.on('end', () => {
        attempt += 1;
        const body = JSON.parse(data) as { input: string[]; dimensions: number };
        requests.push({ authorization: request.headers.authorization, body });
        const result = respond(body, attempt);
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result.body));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${port}/v1`, requests };
  }

  it('sends the model, key and fixed dimensions', async () => {
    const { baseUrl, requests } = await fakeOpenAI(() => ({
      status: 200,
      body: { data: [{ index: 0, embedding: [1, 2] }] },
    }));
    const embedder = createOpenAIEmbedder({ apiKey: 'key', model: 'm', baseUrl });

    await embedder.embed(['hello']);

    expect(requests[0]).toEqual({
      authorization: 'Bearer key',
      body: { model: 'm', input: ['hello'], dimensions: EMBEDDING_DIMENSIONS },
    });
  });

  it('puts vectors back in input order', async () => {
    const { baseUrl } = await fakeOpenAI(() => ({
      status: 200,
      body: {
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      },
    }));
    const embedder = createOpenAIEmbedder({ apiKey: 'key', model: 'm', baseUrl });

    expect(await embedder.embed(['a', 'b'])).toEqual([[1], [2]]);
  });

  it('retries a rate limit when allowed to', async () => {
    const { baseUrl, requests } = await fakeOpenAI((_body, attempt) =>
      attempt === 1
        ? { status: 429, body: { error: 'slow down' } }
        : { status: 200, body: { data: [{ index: 0, embedding: [1] }] } },
    );
    const embedder = createOpenAIEmbedder({ apiKey: 'key', model: 'm', baseUrl, maxAttempts: 2 });

    expect(await embedder.embed(['a'])).toEqual([[1]]);
    expect(requests).toHaveLength(2);
  });

  it('fails at once on a bad key instead of retrying', async () => {
    const { baseUrl, requests } = await fakeOpenAI(() => ({ status: 401, body: { error: 'bad key' } }));
    const embedder = createOpenAIEmbedder({ apiKey: 'key', model: 'm', baseUrl, maxAttempts: 5 });

    await expect(embedder.embed(['a'])).rejects.toThrow('401');
    expect(requests).toHaveLength(1);
  });

  it('does not retry by default, because a caller is waiting', async () => {
    const { baseUrl, requests } = await fakeOpenAI(() => ({ status: 503, body: {} }));
    const embedder = createOpenAIEmbedder({ apiKey: 'key', model: 'm', baseUrl });

    await expect(embedder.embed(['a'])).rejects.toThrow('503');
    expect(requests).toHaveLength(1);
  });
});

describe('query building', () => {
  it('joins words for a keyword search', () => {
    expect(toKeywordQuery('oil change price')).toBe('oil | change | price');
  });

  it('keeps Albanian and German letters', () => {
    expect(toKeywordQuery('çmimi për Öffnungszeiten')).toBe('çmimi | për | öffnungszeiten');
  });

  it('removes characters that would break a tsquery', () => {
    expect(toKeywordQuery(`oil & change | (price) ! 'x' :*`)).toBe('oil | change | price');
  });

  it('drops duplicates and very short words', () => {
    expect(toKeywordQuery('oil oil is a oil')).toBe('oil');
  });

  it('returns nothing when no word is left', () => {
    expect(toKeywordQuery('a ? !')).toBeUndefined();
  });

  it('writes vectors in pgvector text form', () => {
    expect(toVectorLiteral([0.5, -1])).toBe('[0.5,-1]');
  });
});
