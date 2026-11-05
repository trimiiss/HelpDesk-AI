import { traceHeaders } from '@helpdesk/shared';

export interface KnowledgeAnswer {
  found: boolean;
  results: { text: string; source: string }[];
}

export type SearchKnowledge = (query: string) => Promise<KnowledgeAnswer>;

export interface KnowledgeClientOptions {
  baseUrl: string;
  /** A caller is waiting in silence, so this must be short. */
  timeoutMs: number;
}

interface SearchResponse {
  found: boolean;
  results: { text: string; source: string; score: number }[];
}

export function createKnowledgeClient(options: KnowledgeClientOptions): SearchKnowledge {
  const url = `${options.baseUrl.replace(/\/$/, '')}/search`;

  return async (query) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...traceHeaders() },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) throw new Error(`knowledge-service returned ${response.status}`);

    const { found, results } = (await response.json()) as SearchResponse;
    // Scores mean nothing to the model and would only use up tokens.
    return { found, results: results.map(({ text, source }) => ({ text, source })) };
  };
}
