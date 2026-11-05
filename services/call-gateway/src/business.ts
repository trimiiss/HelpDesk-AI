import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const schema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  languages: z.array(z.string().min(1)).min(1),
  greeting: z.string().min(1),
});

export type BusinessConfig = z.output<typeof schema>;

export function loadBusinessConfig(path: string): BusinessConfig {
  const result = schema.safeParse(parse(readFileSync(path, 'utf8')));
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid business config in ${path}:\n${problems}`);
  }
  return result.data;
}
