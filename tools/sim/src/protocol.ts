/**
 * The simulation can't hear or speak, so words travel inside the audio bytes: a
 * marker at the start of a frame carries the text, and the gateway passes it
 * through without knowing, exactly as it does with real audio.
 */

const CALLER_MARKER = 'SIM-SAY:';
const AGENT_MARKER = 'SIM-AGENT:';

export const BYTES_PER_MS = 8;
/** One 20 ms frame of mu-law silence, which is what Twilio sends between words. */
export const SILENCE_FRAME = Buffer.alloc(160, 0xff).toString('base64');

const encode = (marker: string, text: string): Buffer => Buffer.from(`${marker}${text}\0`, 'utf8');

function decode(marker: string, payload: string): string | undefined {
  const bytes = Buffer.from(payload, 'base64');
  const prefix = Buffer.from(marker, 'utf8');
  if (bytes.length < prefix.length || !bytes.subarray(0, prefix.length).equals(prefix)) {
    return undefined;
  }
  const end = bytes.indexOf(0, prefix.length);
  return bytes.subarray(prefix.length, end === -1 ? undefined : end).toString('utf8');
}

export const encodeCallerSpeech = (text: string): string =>
  encode(CALLER_MARKER, text).toString('base64');

export const decodeCallerSpeech = (payload: string): string | undefined =>
  decode(CALLER_MARKER, payload);

export const decodeAgentSpeech = (payload: string): string | undefined =>
  decode(AGENT_MARKER, payload);

/** Agent speech as audio chunks, padded with silence to last as long as real speech would. */
export function encodeAgentSpeech(text: string, chunkMs = 200): string[] {
  const durationMs = Math.max(600, text.length * 60);
  const total = Buffer.alloc(durationMs * BYTES_PER_MS, 0xff);
  encode(AGENT_MARKER, text).copy(total);

  const chunks: string[] = [];
  const chunkBytes = chunkMs * BYTES_PER_MS;
  for (let start = 0; start < total.length; start += chunkBytes) {
    chunks.push(total.subarray(start, start + chunkBytes).toString('base64'));
  }
  return chunks;
}
