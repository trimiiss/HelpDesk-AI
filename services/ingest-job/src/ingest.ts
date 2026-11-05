import {
  hashContent,
  toVectorLiteral,
  type ChunkRow,
  type Embedder,
  type KnowledgeStore,
} from '@helpdesk/knowledge';
import type { Logger } from '@helpdesk/shared';
import { chunkFile, listKnowledgeFiles } from './extract.js';

const EMBED_BATCH_SIZE = 100;

export type IngestStore = Pick<
  KnowledgeStore,
  'activeGeneration' | 'reusableEmbeddings' | 'publishGeneration' | 'withIngestLock'
>;

export type IngestResult =
  | { status: 'unchanged' }
  | { status: 'locked' }
  | { status: 'published'; generationId: string; chunks: number; embedded: number };

interface PendingChunk {
  source: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
}

async function readChunks(directory: string, log: Logger): Promise<PendingChunk[]> {
  const files = listKnowledgeFiles(directory);
  if (files.length === 0) throw new Error(`No files found in ${directory}`);

  const chunks: PendingChunk[] = [];
  for (const file of files) {
    const pieces = await chunkFile(file);
    log.info({ source: file.source, chunks: pieces.length }, 'read file');
    pieces.forEach((content, chunkIndex) => {
      chunks.push({
        source: file.source,
        chunkIndex,
        content,
        contentHash: hashContent(content),
      });
    });
  }
  return chunks;
}

/**
 * Rebuilds the index from the knowledge folder. Reading every file comes first,
 * so one bad file stops the job before anything changes, and the live index keeps
 * serving. Unchanged chunks reuse their stored vectors, so a small edit costs one
 * small embedding call instead of re-embedding everything.
 */
export async function runIngest(
  directory: string,
  store: IngestStore,
  embedder: Embedder,
  log: Logger,
): Promise<IngestResult> {
  const chunks = await readChunks(directory, log);
  const corpusHash = hashContent(
    [embedder.model, ...chunks.map((chunk) => `${chunk.source}:${chunk.contentHash}`)].join('\n'),
  );

  let result: IngestResult = { status: 'locked' };

  const finished = await store.withIngestLock(async () => {
    const active = await store.activeGeneration();
    if (active?.corpusHash === corpusHash) {
      result = { status: 'unchanged' };
      return;
    }

    const reusable = active
      ? await store.reusableEmbeddings(active.id, embedder.model)
      : new Map<string, string>();

    const toEmbed = [
      ...new Map(
        chunks
          .filter((chunk) => !reusable.has(chunk.contentHash))
          .map((chunk) => [chunk.contentHash, chunk.content]),
      ),
    ];

    for (let start = 0; start < toEmbed.length; start += EMBED_BATCH_SIZE) {
      const batch = toEmbed.slice(start, start + EMBED_BATCH_SIZE);
      const vectors = await embedder.embed(batch.map(([, content]) => content));
      if (vectors.length !== batch.length) throw new Error('embedding count mismatch');
      batch.forEach(([contentHash], index) => {
        const vector = vectors[index];
        if (vector) reusable.set(contentHash, toVectorLiteral(vector));
      });
    }

    const rows: ChunkRow[] = chunks.map((chunk) => {
      const embedding = reusable.get(chunk.contentHash);
      if (!embedding) throw new Error(`no embedding for a chunk of ${chunk.source}`);
      return { ...chunk, embedding };
    });

    const generationId = await store.publishGeneration(corpusHash, embedder.model, rows);
    result = { status: 'published', generationId, chunks: rows.length, embedded: toEmbed.length };
  });

  return finished ? result : { status: 'locked' };
}
