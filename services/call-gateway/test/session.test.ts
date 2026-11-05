import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBusinessConfig } from '../src/business.js';
import { loadConfig } from '../src/config.js';
import { buildInstructions } from '../src/prompt.js';
import { buildSessionUpdate, TRANSFER_TOOL } from '../src/session.js';

const VALID_ENV = {
  PUBLIC_BASE_URL: 'https://helpdesk.example.test',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token',
  OPENAI_API_KEY: 'key',
};

const BUSINESS_PATH = fileURLToPath(new URL('../../../config/business.yaml', import.meta.url));

interface ToolDefinition {
  name: string;
  parameters: { properties: Record<string, unknown> };
}

describe('session.update', () => {
  const update = buildSessionUpdate(loadConfig(VALID_ENV), 'instructions') as {
    session: Record<string, unknown> & { tools: ToolDefinition[] };
  };

  it('uses the GA telephony format in both directions', () => {
    expect(update.session).toMatchObject({
      type: 'realtime',
      output_modalities: ['audio'],
      audio: {
        input: { format: { type: 'audio/pcmu' } },
        output: { format: { type: 'audio/pcmu' } },
      },
    });
  });

  it('contains none of the beta fields the GA API rejects', () => {
    const text = JSON.stringify(update);
    expect(text).not.toContain('g711_ulaw');
    expect(text).not.toContain('input_audio_format');
    expect(text).not.toContain('output_audio_format');
  });

  it('leaves the model to the URL, because the API will not change it here', () => {
    expect(update.session.model).toBeUndefined();
  });

  it('lets OpenAI cut off a response when the caller starts speaking', () => {
    expect(update.session).toMatchObject({
      audio: { input: { turn_detection: { type: 'server_vad', interrupt_response: true } } },
    });
  });

  it('gives the model no way to choose where a transfer goes', () => {
    const tool = update.session.tools.find(({ name }) => name === TRANSFER_TOOL);
    expect(tool).toBeDefined();
    expect(Object.keys(tool?.parameters.properties ?? {})).toEqual(['reason']);
  });
});

describe('system prompt', () => {
  const business = loadBusinessConfig(BUSINESS_PATH);

  it('is identical every time, so the prompt cache can be reused', () => {
    expect(buildInstructions(business, { transferAvailable: true })).toBe(
      buildInstructions(business, { transferAvailable: true }),
    );
  });

  it('names the business, languages and exact greeting', () => {
    const prompt = buildInstructions(business, { transferAvailable: true });
    expect(prompt).toContain(business.name);
    for (const language of business.languages) expect(prompt).toContain(language);
    expect(prompt).toContain(business.greeting);
  });

  it('forbids invented answers', () => {
    expect(buildInstructions(business, { transferAvailable: true })).toContain('Never invent');
  });

  it('only mentions the transfer tool when a transfer is possible', () => {
    expect(buildInstructions(business, { transferAvailable: true })).toContain(TRANSFER_TOOL);
    expect(buildInstructions(business, { transferAvailable: false })).not.toContain(TRANSFER_TOOL);
  });
});

describe('business config', () => {
  it('loads the committed file with the AI disclosure in the greeting', () => {
    const business = loadBusinessConfig(BUSINESS_PATH);
    expect(business.languages).toEqual(['Albanian', 'English', 'German']);
    expect(business.greeting).toContain('inteligjencë artificiale');
    expect(business.greeting).toContain('transkriptohet');
  });
});

describe('gateway config', () => {
  it('applies the defaults from the plan', () => {
    expect(loadConfig(VALID_ENV)).toMatchObject({
      REALTIME_MODEL: 'gpt-realtime-2.1-mini',
      MAX_CALL_SECONDS: 600,
      LOG_TRANSCRIPTS: false,
    });
  });

  it('strips a trailing slash from the public URL', () => {
    const config = loadConfig({ ...VALID_ENV, PUBLIC_BASE_URL: 'https://example.test/' });
    expect(config.PUBLIC_BASE_URL).toBe('https://example.test');
  });

  it('treats a blank transfer number as unset', () => {
    expect(loadConfig({ ...VALID_ENV, TRANSFER_NUMBER: '' }).TRANSFER_NUMBER).toBeUndefined();
  });

  it.each([
    ['a non-E.164 transfer number', { TRANSFER_NUMBER: '044123456' }],
    ['an http public URL', { PUBLIC_BASE_URL: 'http://example.test' }],
    ['a public URL with a path', { PUBLIC_BASE_URL: 'https://example.test/voice' }],
    ['a malformed account SID', { TWILIO_ACCOUNT_SID: 'not-a-sid' }],
    ['a goodbye longer than the call', { GOODBYE_LEAD_SECONDS: '700' }],
  ])('rejects %s', (_name, overrides) => {
    expect(() => loadConfig({ ...VALID_ENV, ...overrides })).toThrow(/Invalid configuration/);
  });

  it('names every missing secret at once', () => {
    expect(() => loadConfig({})).toThrow(/OPENAI_API_KEY/);
    expect(() => loadConfig({})).toThrow(/TWILIO_AUTH_TOKEN/);
    expect(() => loadConfig({})).toThrow(/PUBLIC_BASE_URL/);
  });
});
