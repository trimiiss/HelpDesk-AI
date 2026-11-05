import type { z } from 'zod';

/**
 * Validates environment variables against a schema. Blank values count as
 * unset, so `FOO=` in a .env file falls back to the schema default. Errors name
 * the variable but never print its value, because many of these are secrets.
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.output<T> {
  const provided = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== undefined && value !== ''),
  );

  const result = schema.safeParse(provided);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  return result.data;
}
