import { fileURLToPath } from 'node:url';
import { createPool, migrate, type Pool } from '@helpdesk/db';
import { createLogger } from '@helpdesk/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLocalEmbedder } from '../src/embedder.js';
import { hashContent, KnowledgeStore, toVectorLiteral, type ChunkRow } from '../src/store.js';

/** Runs against a real database, because the search SQL is what's being tested. */
const url = process.env.TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../db/migrations', import.meta.url));
const embedder = createLocalEmbedder();

async function rows(source: string, texts: string[]): Promise<ChunkRow[]> {
  const vectors = await embedder.embed(texts);
  return texts.map((content, chunkIndex) => ({
    source,
    chunkIndex,
    content,
    contentHash: hashContent(content),
    embedding: toVectorLiteral(vectors[chunkIndex] ?? []),
  }));
}

describe.runIf(url)('KnowledgeStore with Postgres', () => {
  let pool: Pool;
  let store: KnowledgeStore;

  const search = async (query: string, topK = 3) => {
    const [vector] = await embedder.embed([query]);
    return store.search(toVectorLiteral(vector ?? []), query, topK);
  };

  beforeAll(async () => {
    pool = createPool(url ?? '');
    await migrate(pool, migrations, createLogger('test', 'silent'));
    store = new KnowledgeStore(pool);
  });

  beforeEach(async () => {
    await pool.query('UPDATE knowledge_state SET active_generation_id = NULL');
    await pool.query('DELETE FROM knowledge_generations');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('finds nothing before anything is indexed', async () => {
    expect(await store.activeGeneration()).toBeUndefined();
    expect(await search('hours')).toEqual([]);
  });

  it('ranks the chunk that matches the question first', async () => {
    await store.publishGeneration(
      'h1',
      embedder.model,
      await rows('faq.md', ['Opening hours Monday to Friday', 'Oil change costs 45 euros', 'Parking is free']),
    );

    const hits = await search('how much is an oil change');

    expect(hits[0]?.text).toContain('Oil change');
    expect(hits[0]?.source).toBe('faq.md');
    expect(hits[0]?.similarity).toBeGreaterThan(hits[1]?.similarity ?? 1);
  });

  it('finds exact words through the keyword half of the search', async () => {
    await store.publishGeneration(
      'h1',
      embedder.model,
      await rows('faq.md', ['Part XK-4471 fits the front axle', 'Something else entirely about tyres']),
    );

    const hits = await search('XK-4471');

    expect(hits[0]?.text).toContain('XK-4471');
  });

  it('survives a query made only of punctuation', async () => {
    await store.publishGeneration('h1', embedder.model, await rows('faq.md', ['Some text']));
    await expect(search(`' OR 1=1; --`)).resolves.toBeDefined();
  });

  it('respects the requested number of results', async () => {
    await store.publishGeneration(
      'h1',
      embedder.model,
      await rows('faq.md', ['one thing', 'two things', 'three things', 'four things']),
    );
    expect(await search('things', 2)).toHaveLength(2);
  });

  it('swaps generations so old content disappears completely', async () => {
    await store.publishGeneration('h1', embedder.model, await rows('old.md', ['We open at eight']));
    await store.publishGeneration('h2', embedder.model, await rows('new.md', ['We open at nine']));

    const hits = await search('when do you open');

    expect(hits.map((hit) => hit.source)).toEqual(['new.md']);
    expect((await store.activeGeneration())?.corpusHash).toBe('h2');
  });

  it('keeps the old index if publishing fails part way', async () => {
    await store.publishGeneration('h1', embedder.model, await rows('old.md', ['We open at eight']));

    const broken: ChunkRow = {
      source: 'bad.md',
      chunkIndex: 0,
      content: 'x',
      contentHash: 'x',
      embedding: 'not a vector',
    };
    await expect(store.publishGeneration('h2', embedder.model, [broken])).rejects.toThrow();

    expect((await store.activeGeneration())?.corpusHash).toBe('h1');
    expect((await search('open'))[0]?.source).toBe('old.md');
  });

  it('hands back stored vectors so unchanged chunks need no new embedding', async () => {
    const chunks = await rows('faq.md', ['Parking is free']);
    const id = await store.publishGeneration('h1', embedder.model, chunks);

    const reusable = await store.reusableEmbeddings(id, embedder.model);

    expect(reusable.has(chunks[0]?.contentHash ?? '')).toBe(true);
    expect(await store.reusableEmbeddings(id, 'another-model')).toEqual(new Map());
  });

  it('lets only one ingest run at a time', async () => {
    let inner: boolean | undefined;
    const outer = await store.withIngestLock(async () => {
      inner = await store.withIngestLock(async () => {});
    });
    expect(outer).toBe(true);
    expect(inner).toBe(false);
  });

  it('releases the lock even when the job fails', async () => {
    await store
      .withIngestLock(async () => {
        throw new Error('boom');
      })
      .catch(() => {});
    expect(await store.withIngestLock(async () => {})).toBe(true);
  });
});
