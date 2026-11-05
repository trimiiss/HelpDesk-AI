import { parse } from 'csv-parse/sync';

export interface ChunkOptions {
  /** Aim for pieces around this size. Small enough to be specific, big enough to make sense alone. */
  maxChars: number;
  /** Repeated between pieces of a long section, so a sentence split in two can still be found. */
  overlapChars: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 900, overlapChars: 120 };

/** Splits at paragraph, then sentence, then word boundaries so no piece exceeds the limit. */
function splitText(text: string, options: ChunkOptions): string[] {
  const clean = text.trim();
  if (clean.length === 0) return [];
  if (clean.length <= options.maxChars) return [clean];

  const pieces: string[] = [];
  const units = clean.split(/\n\s*\n/).flatMap((paragraph) =>
    paragraph.length <= options.maxChars
      ? [paragraph.trim()]
      : (paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph]).map((sentence) => sentence.trim()),
  );

  let current = '';
  const flush = () => {
    if (current) pieces.push(current);
    current = '';
  };

  for (const unit of units) {
    if (unit.length > options.maxChars) {
      flush();
      for (let start = 0; start < unit.length; start += options.maxChars - options.overlapChars) {
        pieces.push(unit.slice(start, start + options.maxChars));
      }
      continue;
    }

    const joined = current ? `${current}\n\n${unit}` : unit;
    if (joined.length > options.maxChars) {
      const carry = current.slice(-options.overlapChars);
      flush();
      const boundary = carry.indexOf(' ');
      const overlap = boundary === -1 ? '' : carry.slice(boundary + 1);
      current = overlap && overlap.length + unit.length + 1 <= options.maxChars ? `${overlap} ${unit}` : unit;
    } else {
      current = joined;
    }
  }
  flush();
  return pieces;
}

export function chunkPlainText(text: string, options = DEFAULT_CHUNK_OPTIONS): string[] {
  return splitText(text, options);
}

/**
 * Keeps each section whole where it can, and prefixes its headings. "Monday to
 * Friday, 8 to 18" tells search very little without "Opening hours" beside it.
 */
export function chunkMarkdown(text: string, options = DEFAULT_CHUNK_OPTIONS): string[] {
  const chunks: string[] = [];
  const headings: string[] = [];
  let body: string[] = [];

  const flush = () => {
    const content = body.join('\n').trim();
    body = [];
    if (!content) return;

    const context = headings.filter(Boolean).join(' > ');
    const room = { ...options, maxChars: options.maxChars - context.length - 1 };
    for (const piece of splitText(content, room)) {
      chunks.push(context ? `${context}\n${piece}` : piece);
    }
  };

  for (const line of text.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      headings.length = level - 1;
      headings[level - 1] = (heading[2] ?? '').trim();
    } else {
      body.push(line);
    }
  }
  flush();
  return chunks;
}

/** Turns each row into "column: value" text, so a price keeps the name of what it's for. */
export function chunkCsv(text: string, rowsPerChunk = 5): string[] {
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  }) as Record<string, string>[];

  const lines = rows.map((row) =>
    Object.entries(row)
      .filter(([, value]) => value !== '')
      .map(([column, value]) => `${column}: ${value}`)
      .join(', '),
  );

  const chunks: string[] = [];
  for (let start = 0; start < lines.length; start += rowsPerChunk) {
    chunks.push(lines.slice(start, start + rowsPerChunk).join('\n'));
  }
  return chunks;
}
