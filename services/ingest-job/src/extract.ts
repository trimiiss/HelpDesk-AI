import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { chunkCsv, chunkMarkdown, chunkPlainText } from './chunker.js';

export interface SourceFile {
  /** Relative path with forward slashes, the same on every machine. */
  source: string;
  path: string;
}

/** Folders that aren't knowledge. eval/ holds test questions, and must never become answers. */
const SKIPPED_FOLDERS = new Set(['eval']);

export function listKnowledgeFiles(root: string): SourceFile[] {
  const files: SourceFile[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) walk(path);
      } else if (entry.isFile()) {
        files.push({ path, source: relative(root, path).split(sep).join('/') });
      }
    }
  };

  walk(root);
  return files.sort((a, b) => a.source.localeCompare(b.source));
}

async function extractPdf(path: string): Promise<string[]> {
  const document = await getDocumentProxy(new Uint8Array(readFileSync(path)));
  const { text } = await extractText(document, { mergePages: false });
  return text.flatMap((page) => chunkPlainText(page));
}

/**
 * Turns one file into chunks. A file that yields nothing is an error, not a
 * warning: a scanned PDF has no text layer, and quietly skipping it would leave
 * the agent saying "I don't know" about something you believe it was given.
 */
export async function chunkFile(file: SourceFile): Promise<string[]> {
  const extension = extname(file.source).toLowerCase();

  const chunks = await (async () => {
    switch (extension) {
      case '.md':
      case '.markdown':
        return chunkMarkdown(readFileSync(file.path, 'utf8'));
      case '.txt':
        return chunkPlainText(readFileSync(file.path, 'utf8'));
      case '.csv':
        return chunkCsv(readFileSync(file.path, 'utf8'));
      case '.pdf':
        return extractPdf(file.path);
      default:
        throw new Error(
          `${file.source}: unsupported file type. Use .md, .txt, .csv or .pdf, or move it out of the knowledge folder.`,
        );
    }
  })();

  if (chunks.length === 0) {
    const hint = extension === '.pdf' ? ' It may be a scan, which needs OCR first.' : '';
    throw new Error(`${file.source}: no text found.${hint}`);
  }
  return chunks;
}
