CREATE EXTENSION IF NOT EXISTS vector;

-- Each re-index builds a complete new generation. Search only reads the active
-- one, so it never sees a half-finished index.
CREATE TABLE knowledge_generations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  corpus_hash TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  generation_id BIGINT NOT NULL REFERENCES knowledge_generations (id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  -- Vectors from different models can't be compared, so each chunk records its own.
  embedding_model TEXT NOT NULL,
  embedding vector(1536) NOT NULL,
  -- 'simple' applies no language rules, because the files mix several languages.
  search_text tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);

CREATE INDEX knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX knowledge_chunks_search_text_idx ON knowledge_chunks USING gin (search_text);
CREATE INDEX knowledge_chunks_generation_idx ON knowledge_chunks (generation_id);

-- A single row, so flipping to a new generation is one atomic update.
CREATE TABLE knowledge_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  active_generation_id BIGINT REFERENCES knowledge_generations (id)
);

INSERT INTO knowledge_state DEFAULT VALUES;
