import { describe, expect, it } from 'vitest';
import { chunkCsv, chunkMarkdown, chunkPlainText } from '../src/chunker.js';

const small = { maxChars: 100, overlapChars: 20 };

describe('chunkMarkdown', () => {
  it('keeps each section with its headings', () => {
    const chunks = chunkMarkdown('# Garage\n\n## Opening hours\n\nMonday to Friday, 8 to 18.\n');
    expect(chunks).toEqual(['Garage > Opening hours\nMonday to Friday, 8 to 18.']);
  });

  it('starts a new chunk for each section', () => {
    const chunks = chunkMarkdown('## Hours\nOpen at 8.\n\n## Address\nMain Street 1.\n');
    expect(chunks).toEqual(['Hours\nOpen at 8.', 'Address\nMain Street 1.']);
  });

  it('forgets a heading once its section has ended', () => {
    const chunks = chunkMarkdown('# A\n## B\nfirst\n## C\nsecond\n# D\nthird\n');
    expect(chunks).toEqual(['A > B\nfirst', 'A > C\nsecond', 'D\nthird']);
  });

  it('skips headings with nothing under them', () => {
    expect(chunkMarkdown('# Title\n\n## Empty\n\n## Filled\ntext\n')).toEqual([
      'Title > Filled\ntext',
    ]);
  });

  it('keeps Albanian and German characters intact', () => {
    const chunks = chunkMarkdown('## Çmimet\nNdërrimi i vajit kushton 45 €.\n## Öffnungszeiten\nMontag bis Freitag.\n');
    expect(chunks[0]).toBe('Çmimet\nNdërrimi i vajit kushton 45 €.');
    expect(chunks[1]).toBe('Öffnungszeiten\nMontag bis Freitag.');
  });

  it('handles Windows line endings', () => {
    expect(chunkMarkdown('## Hours\r\nOpen at 8.\r\n')).toEqual(['Hours\nOpen at 8.']);
  });

  it('splits a long section and keeps the heading on every piece', () => {
    const long = Array.from({ length: 30 }, (_, index) => `Sentence number ${index}.`).join(' ');
    const chunks = chunkMarkdown(`## Warranty\n${long}\n`, small);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith('Warranty\n')).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(small.maxChars);
    }
  });
});

describe('chunkPlainText', () => {
  it('returns short text whole', () => {
    expect(chunkPlainText('A short note.')).toEqual(['A short note.']);
  });

  it('returns nothing for blank text', () => {
    expect(chunkPlainText('  \n\n  ')).toEqual([]);
  });

  it('never exceeds the size limit', () => {
    const text = Array.from({ length: 80 }, (_, index) => `Line ${index} of the document.`).join('\n\n');
    for (const chunk of chunkPlainText(text, small)) {
      expect(chunk.length).toBeLessThanOrEqual(small.maxChars);
    }
  });

  it('splits a single enormous word rather than losing it', () => {
    const chunks = chunkPlainText('x'.repeat(350), small);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toContain('x'.repeat(100));
  });

  it('loses no sentences', () => {
    const sentences = Array.from({ length: 40 }, (_, index) => `Fact ${index} is here.`);
    const joined = chunkPlainText(sentences.join(' '), small).join(' ');
    for (const sentence of sentences) expect(joined).toContain(sentence);
  });

  it('overlaps long text so a split sentence can still be found', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} has some words in it.`);
    const chunks = chunkPlainText(paragraphs.join('\n\n'), small);
    const tail = chunks[0]?.split(' ').slice(-3).join(' ') ?? '';
    expect(chunks[1]).toContain(tail);
  });
});

describe('chunkCsv', () => {
  it('labels each value with its column', () => {
    expect(chunkCsv('service,price\nOil change,45\n')).toEqual(['service: Oil change, price: 45']);
  });

  it('handles quoted commas', () => {
    expect(chunkCsv('service,price\n"Oil, filter and check",45\n')).toEqual([
      'service: Oil, filter and check, price: 45',
    ]);
  });

  it('groups rows into chunks', () => {
    const csv = `a\n${Array.from({ length: 7 }, (_, index) => index).join('\n')}\n`;
    expect(chunkCsv(csv, 3)).toHaveLength(3);
  });

  it('leaves out empty values', () => {
    expect(chunkCsv('service,note\nOil change,\n')).toEqual(['service: Oil change']);
  });

  it('ignores a byte order mark from Excel', () => {
    expect(chunkCsv('﻿service\nOil change\n')).toEqual(['service: Oil change']);
  });
});
