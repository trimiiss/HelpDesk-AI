import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEnv } from '../src/env.js';
import { maskPhone } from '../src/logger.js';

describe('parseEnv', () => {
  const schema = z.object({
    API_KEY: z.string().min(1),
    PORT: z.coerce.number().default(8080),
  });

  it('treats blank values as unset so defaults apply', () => {
    expect(parseEnv(schema, { API_KEY: 'x', PORT: '' })).toEqual({ API_KEY: 'x', PORT: 8080 });
  });

  it('names the missing variable', () => {
    expect(() => parseEnv(schema, {})).toThrow(/API_KEY/);
  });

  it('never prints a rejected value', () => {
    const strict = z.object({ SECRET: z.string().regex(/^ok$/) });
    let message = '';
    try {
      parseEnv(strict, { SECRET: 'super-secret-value' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SECRET');
    expect(message).not.toContain('super-secret-value');
  });
});

describe('maskPhone', () => {
  it('keeps only the last four digits', () => {
    expect(maskPhone('+38344123456')).toBe('***3456');
  });

  it('handles missing and very short values', () => {
    expect(maskPhone(undefined)).toBeUndefined();
    expect(maskPhone('123')).toBe('***');
  });
});
