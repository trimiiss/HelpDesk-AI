import { createHmac, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { BYTES_PER_MS, SILENCE_FRAME } from './protocol.js';

export interface CallerConfig {
  /** Where the gateway is reachable from here, for example http://call-gateway:8080. */
  gatewayUrl: string;
  /** The public URL the gateway signs against, which it believes Twilio is calling. */
  publicBaseUrl: string;
  authToken: string;
}

export interface PlacedCall {
  callSid: string;
  socket: WebSocket;
  twiml: string;
}

const sid = (prefix: string): string => `${prefix}${randomBytes(16).toString('hex')}`;

/** Twilio's signature, computed the way Twilio documents it. */
export function signTwilio(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  const data = Object.keys(params)
    .sort()
    .reduce((text, key) => `${text}${key}${params[key]}`, url);
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

function parseParameters(twiml: string): Record<string, string> {
  const parameters: Record<string, string> = {};
  for (const [, name, value] of twiml.matchAll(/<Parameter name="([^"]*)" value="([^"]*)"/g)) {
    if (name && value !== undefined) parameters[name] = value;
  }
  return parameters;
}

/** Does what Twilio does when a call comes in: webhook first, then the media stream. */
export async function placeCall(config: CallerConfig, from: string, to: string): Promise<PlacedCall> {
  const callSid = sid('CA');
  const params = { CallSid: callSid, From: from, To: to, Direction: 'inbound' };
  const webhook = `${config.publicBaseUrl}/incoming-call`;

  const response = await fetch(`${config.gatewayUrl}/incoming-call`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-twilio-signature': signTwilio(config.authToken, webhook, params),
    },
    body: new URLSearchParams(params),
  });
  if (!response.ok) throw new Error(`webhook returned ${response.status}`);

  const twiml = await response.text();
  const streamUrl = /<Stream url="([^"]+)"/.exec(twiml)?.[1];
  if (!streamUrl) throw new Error('no <Stream> in the TwiML');

  const socket = new WebSocket(`${config.gatewayUrl.replace(/^http/, 'ws')}/media-stream`, {
    headers: { 'x-twilio-signature': signTwilio(config.authToken, streamUrl) },
  });

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });

  const streamSid = sid('MZ');
  socket.send(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  socket.send(
    JSON.stringify({
      event: 'start',
      streamSid,
      start: {
        streamSid,
        callSid,
        tracks: ['inbound'],
        customParameters: parseParameters(twiml),
        mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
      },
    }),
  );

  return { callSid, socket, twiml };
}

/**
 * Plays Twilio's side of a call: media frames every 20 ms, and a mark echoed when
 * the audio before it would have finished playing.
 */
export class MediaPump {
  private readonly startedAt = Date.now();
  private readonly timer: NodeJS.Timeout;
  private readonly markTimers = new Set<NodeJS.Timeout>();
  private pendingMarks: string[] = [];
  private playbackEndsAt = 0;

  constructor(private readonly socket: WebSocket) {
    this.timer = setInterval(() => this.sendFrame(SILENCE_FRAME), 20);
  }

  sendFrame(payload: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        event: 'media',
        media: {
          track: 'inbound',
          timestamp: String(Date.now() - this.startedAt),
          payload,
        },
      }),
    );
  }

  onMedia(payload: string): void {
    const durationMs = Buffer.from(payload, 'base64').length / BYTES_PER_MS;
    this.playbackEndsAt = Math.max(Date.now(), this.playbackEndsAt) + durationMs;
  }

  onMark(name: string): void {
    this.pendingMarks.push(name);
    const timer = setTimeout(() => {
      this.markTimers.delete(timer);
      this.pendingMarks = this.pendingMarks.filter((mark) => mark !== name);
      this.echoMark(name);
    }, Math.max(0, this.playbackEndsAt - Date.now()));
    this.markTimers.add(timer);
  }

  /** Twilio echoes outstanding marks immediately after a clear. */
  onClear(): void {
    for (const timer of this.markTimers) clearTimeout(timer);
    this.markTimers.clear();
    for (const name of this.pendingMarks) this.echoMark(name);
    this.pendingMarks = [];
    this.playbackEndsAt = 0;
  }

  stop(): void {
    clearInterval(this.timer);
    for (const timer of this.markTimers) clearTimeout(timer);
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ event: 'stop' }));
      this.socket.close();
    }
  }

  private echoMark(name: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ event: 'mark', mark: { name } }));
    }
  }
}
