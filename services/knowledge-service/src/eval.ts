import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { SearchResponse } from './server.js';

/**
 * Measures search quality against knowledge/eval/questions.yaml. The two numbers
 * that matter: how often an answerable question finds the right file, and how
 * often an unanswerable one wrongly reports a match.
 *
 * Run with `npm run eval:rag` while the stack is up.
 */

const questionSet = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      language: z.string(),
      // The file that holds the answer. Leave it out for a question nothing answers.
      source: z.string().optional(),
    }),
  ),
});

const baseUrl = process.env.KNOWLEDGE_SERVICE_URL ?? 'http://localhost:8081';
const path = process.argv[2] ?? 'knowledge/eval/questions.yaml';
const { questions } = questionSet.parse(parse(readFileSync(path, 'utf8')));

async function search(query: string): Promise<SearchResponse> {
  const response = await fetch(`${baseUrl}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`search returned ${response.status}`);
  return (await response.json()) as SearchResponse;
}

interface Tally {
  answerable: number;
  hits: number;
  unanswerable: number;
  falseMatches: number;
}

const tallies = new Map<string, Tally>();
const misses: string[] = [];

for (const item of questions) {
  const tally = tallies.get(item.language) ?? {
    answerable: 0,
    hits: 0,
    unanswerable: 0,
    falseMatches: 0,
  };
  tallies.set(item.language, tally);

  const { found, results } = await search(item.question);
  const top = results[0];

  if (item.source) {
    tally.answerable += 1;
    if (results.some((result) => result.source === item.source)) {
      tally.hits += 1;
    } else {
      misses.push(`MISS   [${item.language}] ${item.question} (wanted ${item.source})`);
    }
  } else {
    tally.unanswerable += 1;
    if (found) {
      tally.falseMatches += 1;
      misses.push(
        `FALSE  [${item.language}] ${item.question} (matched ${top?.source} at ${top?.score.toFixed(3)})`,
      );
    }
  }
}

const percent = (part: number, whole: number) =>
  whole === 0 ? 'n/a' : `${Math.round((part / whole) * 100)}%`;

console.log('language    found the right file    false matches');
const totals: Tally = { answerable: 0, hits: 0, unanswerable: 0, falseMatches: 0 };
for (const [language, tally] of tallies) {
  totals.answerable += tally.answerable;
  totals.hits += tally.hits;
  totals.unanswerable += tally.unanswerable;
  totals.falseMatches += tally.falseMatches;
  console.log(
    `${language.padEnd(11)} ${`${tally.hits}/${tally.answerable} (${percent(tally.hits, tally.answerable)})`.padEnd(23)} ${tally.falseMatches}/${tally.unanswerable}`,
  );
}
console.log(
  `${'all'.padEnd(11)} ${`${totals.hits}/${totals.answerable} (${percent(totals.hits, totals.answerable)})`.padEnd(23)} ${totals.falseMatches}/${totals.unanswerable}`,
);

if (misses.length > 0) {
  console.log(`\n${misses.join('\n')}`);
}
