import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from '@helpdesk/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createCallControl } from '../src/callControl.js';
import { createKnowledgeClient } from '../src/knowledgeClient.js';
import {
  addResponseUsage,
  addTranscriptionUsage,
  createCostEstimator,
  loadPricing,
} from '../src/usage.js';

const pricing = loadPricing(fileURLToPath(new URL('../../../config/pricing.yaml', import.meta.url)));

describe('cost estimate', () => {
  const estimate = createCostEstimator(pricing, 'gpt-realtime-2.1-mini', 'gpt-transcribe');

  it('prices each token type at its own rate', () => {
    expect(estimate({ ...emptyUsage(), audioOutputTokens: 1_000_000 })).toBeCloseTo(20);
    expect(estimate({ ...emptyUsage(), audioInputTokens: 1_000_000 })).toBeCloseTo(10);
    expect(estimate({ ...emptyUsage(), audioCachedTokens: 1_000_000 })).toBeCloseTo(0.3);
    expect(estimate({ ...emptyUsage(), textInputTokens: 1_000_000 })).toBeCloseTo(0.6);
    expect(estimate({ ...emptyUsage(), textCachedTokens: 1_000_000 })).toBeCloseTo(0.06);
    expect(estimate({ ...emptyUsage(), textOutputTokens: 1_000_000 })).toBeCloseTo(2.4);
  });

  it('adds transcription by the minute', () => {
    expect(estimate({ ...emptyUsage(), transcriptionSeconds: 120 })).toBeCloseTo(0.009);
  });

  it('costs nothing for an empty call', () => {
    expect(estimate(emptyUsage())).toBe(0);
  });

  it('uses the rates of the larger model when that is selected', () => {
    const large = createCostEstimator(pricing, 'gpt-realtime-2.1', 'gpt-transcribe');
    expect(large({ ...emptyUsage(), audioOutputTokens: 1_000_000 })).toBeCloseTo(64);
  });

  it('shows zero rather than failing for a model with no rates', () => {
    const unknown = createCostEstimator(pricing, 'some-new-model', 'other');
    expect(unknown({ ...emptyUsage(), audioOutputTokens: 1000, transcriptionSeconds: 60 })).toBe(0);
  });
});

describe('usage from OpenAI', () => {
  it('splits cached tokens out of the input counts, so they are not billed twice', () => {
    const total = emptyUsage();
    addResponseUsage(total, {
      input_token_details: {
        text_tokens: 119,
        audio_tokens: 13,
        cached_tokens_details: { text_tokens: 64, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 30, audio_tokens: 91 },
    });
    expect(total).toMatchObject({
      textInputTokens: 55,
      textCachedTokens: 64,
      audioInputTokens: 13,
      audioCachedTokens: 0,
      textOutputTokens: 30,
      audioOutputTokens: 91,
    });
  });

  it('never goes negative on inconsistent numbers', () => {
    const total = emptyUsage();
    addResponseUsage(total, {
      input_token_details: { text_tokens: 1, cached_tokens_details: { text_tokens: 5 } },
    });
    expect(total.textInputTokens).toBe(0);
  });

  it('ignores a response with no usage', () => {
    const total = emptyUsage();
    addResponseUsage(total, undefined);
    addResponseUsage(total, {});
    expect(total).toEqual(emptyUsage());
  });

  it('reads transcription time directly when reported in seconds', () => {
    const total = emptyUsage();
    addTranscriptionUsage(total, { type: 'duration', seconds: 7.5 });
    expect(total.transcriptionSeconds).toBe(7.5);
  });

  it('estimates transcription time when reported in tokens', () => {
    const total = emptyUsage();
    addTranscriptionUsage(total, { type: 'tokens', input_token_details: { audio_tokens: 100 } });
    expect(total.transcriptionSeconds).toBe(10);
  });
});

describe('clients', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
  });

  async function fake(status: number, responseBody: unknown, delayMs = 0) {
    const seen: { url?: string; authorization?: string; body: string; traceparent?: string } = { body: '' };
    server = createServer((request, response) => {
      seen.url = request.url;
      seen.authorization = request.headers.authorization;
      request.on('data', (chunk) => (seen.body += chunk));
      request.on('end', () => {
        setTimeout(() => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(responseBody));
        }, delayMs);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }

  describe('Twilio call control', () => {
    const options = {
      accountSid: 'AC123',
      authToken: 'token',
      transferNumber: '+38344000000',
    };

    it('transfers with TwiML that dials the configured number', async () => {
      const { url, seen } = await fake(200, {});
      await createCallControl({ ...options, apiBaseUrl: url }).transfer('CA1');

      expect(seen.url).toBe('/2010-04-01/Accounts/AC123/Calls/CA1.json');
      expect(seen.authorization).toBe(`Basic ${Buffer.from('AC123:token').toString('base64')}`);
      expect(new URLSearchParams(seen.body).get('Twiml')).toContain('<Dial>+38344000000</Dial>');
    });

    it('hangs up by marking the call completed', async () => {
      const { url, seen } = await fake(200, {});
      await createCallControl({ ...options, apiBaseUrl: url }).hangup('CA1');
      expect(new URLSearchParams(seen.body).get('Status')).toBe('completed');
    });

    it('reports a failure from Twilio', async () => {
      const { url } = await fake(404, { message: 'no such call' });
      await expect(
        createCallControl({ ...options, apiBaseUrl: url }).hangup('CA1'),
      ).rejects.toThrow('404');
    });

    it('refuses to transfer with no number configured', async () => {
      const { url } = await fake(200, {});
      await expect(
        createCallControl({ ...options, apiBaseUrl: url, transferNumber: undefined }).transfer('CA1'),
      ).rejects.toThrow('TRANSFER_NUMBER');
    });

    it('gives up rather than hanging forever', async () => {
      const { url } = await fake(200, {}, 500);
      await expect(
        createCallControl({ ...options, apiBaseUrl: url, timeoutMs: 20 }).hangup('CA1'),
      ).rejects.toThrow();
    });
  });

  describe('knowledge client', () => {
    it('sends the query and strips scores the model does not need', async () => {
      const { url, seen } = await fake(200, {
        found: true,
        results: [{ text: 'Open at 8', source: 'faq.md', score: 0.8 }],
      });

      const answer = await createKnowledgeClient({ baseUrl: url, timeoutMs: 1000 })('hours');

      expect(JSON.parse(seen.body)).toEqual({ query: 'hours' });
      expect(answer).toEqual({ found: true, results: [{ text: 'Open at 8', source: 'faq.md' }] });
    });

    it('fails on an error status', async () => {
      const { url } = await fake(502, { error: 'search failed' });
      await expect(createKnowledgeClient({ baseUrl: url, timeoutMs: 1000 })('hours')).rejects.toThrow('502');
    });

    it('enforces its time limit, because a caller is waiting', async () => {
      const { url } = await fake(200, { found: false, results: [] }, 500);
      await expect(createKnowledgeClient({ baseUrl: url, timeoutMs: 20 })('hours')).rejects.toThrow();
    });
  });
});
