import { describe, expect, it } from 'vitest';
import {
  BYTES_PER_MS,
  decodeAgentSpeech,
  decodeCallerSpeech,
  encodeAgentSpeech,
  encodeCallerSpeech,
  SILENCE_FRAME,
} from '../src/protocol.js';
import { signTwilio } from '../src/twilioCaller.js';

describe('simulated speech', () => {
  it('carries caller words through audio bytes, including accents', () => {
    expect(decodeCallerSpeech(encodeCallerSpeech('Sa zgjat ndërrimi i vajit?'))).toBe(
      'Sa zgjat ndërrimi i vajit?',
    );
  });

  it('carries agent words in the first audio chunk', () => {
    const chunks = encodeAgentSpeech('Wir öffnen um acht Uhr.');
    expect(decodeAgentSpeech(chunks[0] ?? '')).toBe('Wir öffnen um acht Uhr.');
    expect(decodeAgentSpeech(chunks[1] ?? '')).toBeUndefined();
  });

  it('lasts roughly as long as speech would, so barge-in has something to interrupt', () => {
    const chunks = encodeAgentSpeech('x'.repeat(100));
    const bytes = chunks.reduce((sum, chunk) => sum + Buffer.from(chunk, 'base64').length, 0);
    expect(bytes / BYTES_PER_MS).toBe(6000);
  });

  it('treats ordinary audio as silence', () => {
    expect(decodeCallerSpeech(SILENCE_FRAME)).toBeUndefined();
    expect(decodeAgentSpeech(SILENCE_FRAME)).toBeUndefined();
  });

  it('sends frames the size Twilio sends', () => {
    expect(Buffer.from(SILENCE_FRAME, 'base64')).toHaveLength(160);
  });
});

describe('signing', () => {
  it('matches the example in the Twilio documentation', () => {
    const signature = signTwilio('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      CallSid: 'CA1234567890ABCDE',
      Caller: '+14158675310',
      Digits: '1234',
      From: '+14158675310',
      To: '+18005551212',
    });
    expect(signature).toBe('GvWf1cFY/Q7PnoempGyD5oXAezc=');
  });
});
