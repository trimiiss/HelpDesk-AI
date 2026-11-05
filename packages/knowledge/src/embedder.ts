/** Fixed by the vector(1536) column. Models that allow it are asked for this size. */
export const EMBEDDING_DIMENSIONS = 1536;

export interface Embedder {
  readonly model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
  /** One attempt suits a caller waiting on the line. A batch job can afford retries. */
  maxAttempts?: number;
}

interface EmbeddingsResponse {
  data: { index: number; embedding: number[] }[];
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function createOpenAIEmbedder(options: OpenAIEmbedderOptions): Embedder {
  const maxAttempts = options.maxAttempts ?? 1;
  const url = `${options.baseUrl.replace(/\/$/, '')}/embeddings`;

  const request = async (texts: string[]): Promise<Response> =>
    fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });

  return {
    model: options.model,
    async embed(texts) {
      for (let attempt = 1; ; attempt += 1) {
        const response = await request(texts);
        if (response.ok) {
          const { data } = (await response.json()) as EmbeddingsResponse;
          return [...data].sort((a, b) => a.index - b.index).map((item) => item.embedding);
        }

        if (attempt >= maxAttempts || !RETRYABLE.has(response.status)) {
          const detail = (await response.text()).slice(0, 300);
          throw new Error(`Embedding request failed with ${response.status}: ${detail}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
      }
    },
  };
}

/** Removes accents and case, so "çmimi" and "cmimi" look alike to the local embedder. */
function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/**
 * Lets the system run with no API key, for the simulation and tests. It hashes
 * words and character trigrams, so it matches on spelling only: it has no idea of
 * meaning and can't match across languages. Real deployments use OpenAI.
 */
export function createLocalEmbedder(): Embedder {
  const embedOne = (text: string): number[] => {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const add = (feature: string, weight: number) => {
      const value = hash(feature);
      const slot = value % EMBEDDING_DIMENSIONS;
      vector[slot] = (vector[slot] ?? 0) + (value & 1 ? weight : -weight);
    };

    for (const word of normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
      add(`w:${word}`, 2);
      const padded = ` ${word} `;
      for (let start = 0; start + 3 <= padded.length; start += 1) {
        add(`t:${padded.slice(start, start + 3)}`, 1);
      }
    }

    const length = Math.hypot(...vector);
    return length === 0 ? vector : vector.map((value) => value / length);
  };

  return {
    model: 'local-hash-v1',
    embed: async (texts) => texts.map(embedOne),
  };
}
