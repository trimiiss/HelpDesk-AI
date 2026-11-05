import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface ActiveGeneration {
  id: string;
  corpusHash: string;
  embeddingModel: string;
}

export interface ChunkRow {
  source: string;
  chunkIndex: number;
  content: string;
  contentHash: string;
  embedding: string;
}

export interface SearchHit {
  text: string;
  source: string;
  similarity: number;
  score: number;
}

export const hashContent = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** pgvector reads vectors as text in the form [1,2,3]. */
export const toVectorLiteral = (values: number[]): string => `[${values.join(',')}]`;

/** Keeps letters and digits only, because to_tsquery treats most punctuation as syntax. */
export function toKeywordQuery(query: string): string | undefined {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu);
  return words ? [...new Set(words)].join(' | ') : undefined;
}

/** How far down each list to look before fusing them. */
const CANDIDATES = 30;

/** The usual constant for reciprocal rank fusion. Higher values flatten the ranking. */
const RRF_K = 60;

/** An arbitrary constant. Only one re-index may run at a time. */
const INGEST_LOCK = 8_352_002;

export class KnowledgeStore {
  constructor(private readonly pool: Pool) {}

  async activeGeneration(): Promise<ActiveGeneration | undefined> {
    const { rows } = await this.pool.query<{
      id: string;
      corpus_hash: string;
      embedding_model: string;
    }>(`
      SELECT g.id, g.corpus_hash, g.embedding_model
      FROM knowledge_state s
      JOIN knowledge_generations g ON g.id = s.active_generation_id
    `);
    const row = rows[0];
    return row
      ? { id: row.id, corpusHash: row.corpus_hash, embeddingModel: row.embedding_model }
      : undefined;
  }

  /** Runs a job while holding the ingest lock, or returns false if another job holds it. */
  async withIngestLock(job: () => Promise<void>): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [INGEST_LOCK],
      );
      if (!rows[0]?.locked) return false;
      try {
        await job();
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [INGEST_LOCK]);
      }
      return true;
    } finally {
      client.release();
    }
  }

  /** Embeddings already stored, by content hash, so unchanged chunks cost nothing to re-index. */
  async reusableEmbeddings(generationId: string, model: string): Promise<Map<string, string>> {
    const { rows } = await this.pool.query<{ content_hash: string; embedding: string }>(
      `SELECT DISTINCT ON (content_hash) content_hash, embedding::text AS embedding
       FROM knowledge_chunks
       WHERE generation_id = $1 AND embedding_model = $2`,
      [generationId, model],
    );
    return new Map(rows.map((row) => [row.content_hash, row.embedding]));
  }

  /** Builds a generation and makes it live in one transaction, so a failure changes nothing. */
  async publishGeneration(corpusHash: string, model: string, chunks: ChunkRow[]): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO knowledge_generations (corpus_hash, embedding_model)
         VALUES ($1, $2) RETURNING id`,
        [corpusHash, model],
      );
      const generationId = rows[0]?.id;
      if (!generationId) throw new Error('could not create generation');

      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO knowledge_chunks
             (generation_id, source, chunk_index, content, content_hash, embedding_model, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7::vector)`,
          [
            generationId,
            chunk.source,
            chunk.chunkIndex,
            chunk.content,
            chunk.contentHash,
            model,
            chunk.embedding,
          ],
        );
      }

      await client.query('UPDATE knowledge_state SET active_generation_id = $1', [generationId]);
      await client.query('DELETE FROM knowledge_generations WHERE id <> $1', [generationId]);
      await client.query('COMMIT');
      return generationId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Hybrid search. Embeddings find meaning, but they are weak on exact words such
   * as names and part numbers, so a keyword search runs alongside and reciprocal
   * rank fusion merges the two. Similarity is returned as well, because rank
   * scores can't say whether anything is actually relevant.
   */
  async search(vector: string, query: string, topK: number): Promise<SearchHit[]> {
    const keywordQuery = toKeywordQuery(query) ?? null;
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // Filtering on generation_id happens after the HNSW scan. Without this,
      // the scan can stop early and return too few rows.
      await client.query(`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`);

      const { rows } = await client.query<{
        content: string;
        source: string;
        similarity: string;
        score: string;
      }>(
        `
        WITH active AS (
          SELECT active_generation_id AS id FROM knowledge_state
        ),
        by_vector AS (
          SELECT id, row_number() OVER (ORDER BY distance) AS position
          FROM (
            SELECT c.id, c.embedding <=> $1::vector AS distance
            FROM knowledge_chunks c, active
            WHERE c.generation_id = active.id
            ORDER BY distance
            LIMIT ${CANDIDATES}
          ) ranked
        ),
        by_keyword AS (
          SELECT id, row_number() OVER (ORDER BY relevance DESC) AS position
          FROM (
            SELECT c.id, ts_rank_cd(c.search_text, to_tsquery('simple', $2)) AS relevance
            FROM knowledge_chunks c, active
            WHERE c.generation_id = active.id
              AND $2::text IS NOT NULL
              AND c.search_text @@ to_tsquery('simple', $2)
            ORDER BY relevance DESC
            LIMIT ${CANDIDATES}
          ) ranked
        ),
        fused AS (
          SELECT
            COALESCE(v.id, k.id) AS id,
            COALESCE(1.0 / (${RRF_K} + v.position), 0)
              + COALESCE(1.0 / (${RRF_K} + k.position), 0) AS score
          FROM by_vector v
          FULL OUTER JOIN by_keyword k ON k.id = v.id
        )
        SELECT
          c.content,
          c.source,
          1 - (c.embedding <=> $1::vector) AS similarity,
          f.score
        FROM fused f
        JOIN knowledge_chunks c ON c.id = f.id
        ORDER BY f.score DESC
        LIMIT $3
        `,
        [vector, keywordQuery, topK],
      );

      await client.query('COMMIT');
      return rows.map((row) => ({
        text: row.content,
        source: row.source,
        similarity: Number(row.similarity),
        score: Number(row.score),
      }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
