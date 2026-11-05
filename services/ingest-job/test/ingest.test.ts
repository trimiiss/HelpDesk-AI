import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalEmbedder, toVectorLiteral, type ChunkRow, type Embedder } from '@helpdesk/knowledge';
import { createLogger } from '@helpdesk/shared';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkFile, listKnowledgeFiles } from '../src/extract.js';
import { runIngest, type IngestStore } from '../src/ingest.js';

const log = createLogger('test', 'silent');

function fakeStore() {
  let active: { id: string; corpusHash: string; embeddingModel: string; rows: ChunkRow[] } | undefined;

  const store = {
    activeGeneration: vi.fn(async () => active),
    reusableEmbeddings: vi.fn(
      async () => new Map(active?.rows.map((row) => [row.contentHash, row.embedding])),
    ),
    publishGeneration: vi.fn(async (corpusHash: string, embeddingModel: string, rows: ChunkRow[]) => {
      active = { id: String(Number(active?.id ?? 0) + 1), corpusHash, embeddingModel, rows };
      return active.id;
    }),
    withIngestLock: vi.fn(async (job: () => Promise<void>) => {
      await job();
      return true;
    }),
  };
  return { store: store as IngestStore & typeof store, current: () => active };
}

function countingEmbedder(): Embedder & { texts: string[] } {
  const local = createLocalEmbedder();
  const texts: string[] = [];
  return {
    model: local.model,
    texts,
    embed: async (batch) => {
      texts.push(...batch);
      return local.embed(batch);
    },
  };
}

async function pdf(text?: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const page = document.addPage();
  if (text) {
    const font = await document.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 50, y: 700, size: 12, font });
  }
  return document.save();
}

describe('reading the knowledge folder', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'knowledge-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('finds files in subfolders and uses tidy relative names', () => {
    mkdirSync(join(directory, 'prices'));
    writeFileSync(join(directory, 'prices', 'list.csv'), 'a\n1\n');
    expect(listKnowledgeFiles(directory).map((file) => file.source)).toEqual(['prices/list.csv']);
  });

  it('never treats the eval questions as knowledge', () => {
    mkdirSync(join(directory, 'eval'));
    writeFileSync(join(directory, 'eval', 'questions.yaml'), 'questions: []\n');
    writeFileSync(join(directory, 'faq.md'), '## Hours\nOpen\n');
    expect(listKnowledgeFiles(directory).map((file) => file.source)).toEqual(['faq.md']);
  });

  it('ignores hidden files', () => {
    writeFileSync(join(directory, '.DS_Store'), 'junk');
    writeFileSync(join(directory, 'faq.md'), '## Hours\nOpen\n');
    expect(listKnowledgeFiles(directory)).toHaveLength(1);
  });

  it('reads text from a PDF', async () => {
    const path = join(directory, 'terms.pdf');
    writeFileSync(path, await pdf('Die Garantie gilt zwei Jahre.'));
    const chunks = await chunkFile({ source: 'terms.pdf', path });
    expect(chunks.join(' ')).toContain('Garantie gilt zwei Jahre');
  });

  it('fails loudly on a scanned PDF with no text', async () => {
    const path = join(directory, 'scan.pdf');
    writeFileSync(path, await pdf());
    await expect(chunkFile({ source: 'scan.pdf', path })).rejects.toThrow(/scan\.pdf.*scan/);
  });

  it('fails loudly on a file type it cannot read', async () => {
    const path = join(directory, 'notes.docx');
    writeFileSync(path, 'binary');
    await expect(chunkFile({ source: 'notes.docx', path })).rejects.toThrow(/notes\.docx.*unsupported/);
  });

  it('fails loudly on an empty file', async () => {
    const path = join(directory, 'empty.md');
    writeFileSync(path, '   \n');
    await expect(chunkFile({ source: 'empty.md', path })).rejects.toThrow(/empty\.md.*no text/);
  });
});

describe('runIngest', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'knowledge-'));
    writeFileSync(join(directory, 'faq.md'), '## Hours\nOpen at 8.\n\n## Address\nMain Street 1.\n');
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('embeds and publishes everything on the first run', async () => {
    const { store, current } = fakeStore();
    const embedder = countingEmbedder();

    const result = await runIngest(directory, store, embedder, log);

    expect(result).toMatchObject({ status: 'published', chunks: 2, embedded: 2 });
    expect(current()?.rows.map((row) => row.source)).toEqual(['faq.md', 'faq.md']);
    expect(current()?.embeddingModel).toBe(embedder.model);
  });

  it('does nothing when no file has changed', async () => {
    const { store } = fakeStore();
    const embedder = countingEmbedder();
    await runIngest(directory, store, embedder, log);
    embedder.texts.length = 0;

    const result = await runIngest(directory, store, embedder, log);

    expect(result).toEqual({ status: 'unchanged' });
    expect(embedder.texts).toEqual([]);
    expect(store.publishGeneration).toHaveBeenCalledOnce();
  });

  it('embeds only what changed', async () => {
    const { store } = fakeStore();
    const embedder = countingEmbedder();
    await runIngest(directory, store, embedder, log);
    embedder.texts.length = 0;

    writeFileSync(join(directory, 'faq.md'), '## Hours\nOpen at 9.\n\n## Address\nMain Street 1.\n');
    const result = await runIngest(directory, store, embedder, log);

    expect(result).toMatchObject({ status: 'published', chunks: 2, embedded: 1 });
    expect(embedder.texts).toEqual(['Hours\nOpen at 9.']);
  });

  it('re-embeds everything when the embedding model changes', async () => {
    const { store } = fakeStore();
    const embedder = countingEmbedder();
    await runIngest(directory, store, embedder, log);
    store.reusableEmbeddings.mockResolvedValueOnce(new Map());
    embedder.texts.length = 0;

    const other: Embedder = { model: 'other-model', embed: embedder.embed };
    const result = await runIngest(directory, store, other, log);

    expect(result).toMatchObject({ status: 'published', embedded: 2 });
  });

  it('embeds identical text only once', async () => {
    writeFileSync(join(directory, 'copy.md'), '## Hours\nOpen at 8.\n');
    const { store, current } = fakeStore();
    const embedder = countingEmbedder();

    await runIngest(directory, store, embedder, log);

    expect(embedder.texts.filter((text) => text.includes('Open at 8'))).toHaveLength(1);
    expect(current()?.rows).toHaveLength(3);
  });

  it('changes nothing when one file is bad', async () => {
    const { store, current } = fakeStore();
    const embedder = countingEmbedder();
    await runIngest(directory, store, embedder, log);
    const before = current();

    writeFileSync(join(directory, 'broken.docx'), 'binary');

    await expect(runIngest(directory, store, embedder, log)).rejects.toThrow('broken.docx');
    expect(current()).toBe(before);
  });

  it('keeps the live index if embedding fails part way', async () => {
    const { store, current } = fakeStore();
    const failing: Embedder = {
      model: 'm',
      embed: async () => {
        throw new Error('openai is down');
      },
    };

    await expect(runIngest(directory, store, failing, log)).rejects.toThrow('openai is down');
    expect(current()).toBeUndefined();
  });

  it('stops if the embedder returns the wrong number of vectors', async () => {
    const { store } = fakeStore();
    const short: Embedder = { model: 'm', embed: async () => [[1]] };
    await expect(runIngest(directory, store, short, log)).rejects.toThrow('mismatch');
  });

  it('refuses an empty folder rather than wiping the index', async () => {
    rmSync(join(directory, 'faq.md'));
    const { store } = fakeStore();
    await expect(runIngest(directory, store, countingEmbedder(), log)).rejects.toThrow('No files');
    expect(store.publishGeneration).not.toHaveBeenCalled();
  });

  it('reports when another job holds the lock', async () => {
    const { store } = fakeStore();
    store.withIngestLock.mockResolvedValueOnce(false);
    const result = await runIngest(directory, store, countingEmbedder(), log);
    expect(result).toEqual({ status: 'locked' });
  });

  it('stores vectors in the format pgvector expects', async () => {
    const { store, current } = fakeStore();
    await runIngest(directory, store, countingEmbedder(), log);
    expect(current()?.rows[0]?.embedding).toMatch(/^\[[-\d.e,]+\]$/);
    expect(toVectorLiteral([1, 0.5])).toBe('[1,0.5]');
  });
});
