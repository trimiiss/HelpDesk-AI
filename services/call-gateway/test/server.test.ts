import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.js';
import { createRealtimeConnector } from '../src/realtime.js';
import { buildServer, type GatewayServer } from '../src/server.js';
import { buildSessionUpdate } from '../src/session.js';
import {
  audioOfMs,
  CALL_SID,
  fakeEvents,
  fakeMetrics,
  signTwilio,
  silentLog,
  STREAM_SID,
} from './helpers.js';

const AUTH_TOKEN = 'test-auth-token';
const PUBLIC_URL = 'https://helpdesk.example.test';
const WEBHOOK_URL = `${PUBLIC_URL}/incoming-call`;
const STREAM_URL = 'wss://helpdesk.example.test/media-stream';

const CALL_PARAMS = { CallSid: CALL_SID, From: '+15550001111', To: '+15550002222' };

function config(overrides: Record<string, string> = {}) {
  return loadConfig({
    PUBLIC_BASE_URL: PUBLIC_URL,
    TWILIO_ACCOUNT_SID: `AC${'0'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TRANSFER_NUMBER: '+15550009999',
    OPENAI_API_KEY: 'test-openai-key',
    ...overrides,
  });
}

/** Everything a server needs besides config and the OpenAI connection. */
const collaborators = () => ({
  log: silentLog,
  events: fakeEvents(),
  metrics: fakeMetrics(),
  searchKnowledge: vi.fn(async () => ({ found: false, results: [] })),
  estimateCost: () => 0,
});

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

/** Resolves with one message of the given kind from a socket, however soon it arrives. */
function nextMessage(
  messages: Record<string, unknown>[],
  socket: WebSocket,
  matches: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const seen = messages.find(matches);
    if (seen) {
      resolve(seen);
      return;
    }
    const listener = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (matches(message)) {
        socket.off('message', listener);
        resolve(message);
      }
    };
    socket.on('message', listener);
  });
}

describe('POST /incoming-call', () => {
  let server: GatewayServer;

  const post = (headers: Record<string, string>, params: Record<string, string> = CALL_PARAMS) =>
    server.app.inject({
      method: 'POST',
      url: '/incoming-call',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
      payload: formBody(params),
    });

  beforeEach(() => {
    const cfg = config();
    server = buildServer({
      ...collaborators(),
      config: cfg,
      sessionUpdate: {},
      connectRealtime: vi.fn(),
      control: { transfer: vi.fn(), hangup: vi.fn() },
    });
  });

  afterEach(async () => {
    server.mediaStream.shutdown();
    await server.app.close();
  });

  it('rejects a forged webhook', async () => {
    const response = await post({ 'x-twilio-signature': 'forged' });
    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('');
  });

  it('rejects a webhook with no signature', async () => {
    const response = await post({});
    expect(response.statusCode).toBe(403);
  });

  it('rejects a signature made with the wrong token', async () => {
    const signature = signTwilio('wrong-token', WEBHOOK_URL, CALL_PARAMS);
    const response = await post({ 'x-twilio-signature': signature });
    expect(response.statusCode).toBe(403);
  });

  it('rejects a real signature on altered parameters', async () => {
    const signature = signTwilio(AUTH_TOKEN, WEBHOOK_URL, CALL_PARAMS);
    const response = await post(
      { 'x-twilio-signature': signature },
      { ...CALL_PARAMS, From: '+15559998888' },
    );
    expect(response.statusCode).toBe(403);
  });

  it('checks against the public URL, not a Host header an attacker controls', async () => {
    const signature = signTwilio(AUTH_TOKEN, 'https://evil.example.test/incoming-call', CALL_PARAMS);
    const response = await post({
      'x-twilio-signature': signature,
      host: 'evil.example.test',
    });
    expect(response.statusCode).toBe(403);
  });

  it('answers a genuine call with TwiML', async () => {
    const signature = signTwilio(AUTH_TOKEN, WEBHOOK_URL, CALL_PARAMS);
    const response = await post({ 'x-twilio-signature': signature });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect(response.body).toContain(`<Stream url="${STREAM_URL}">`);
    expect(response.body).toContain('<Parameter name="from" value="+15550001111"/>');
    expect(response.body).toContain('<Parameter name="to" value="+15550002222"/>');
  });

  it('puts the human fallback after the stream, where only a dropped socket reaches it', async () => {
    const signature = signTwilio(AUTH_TOKEN, WEBHOOK_URL, CALL_PARAMS);
    const { body } = await post({ 'x-twilio-signature': signature });

    expect(body.indexOf('</Connect>')).toBeGreaterThan(-1);
    expect(body.indexOf('<Dial>+15550009999</Dial>')).toBeGreaterThan(body.indexOf('</Connect>'));
  });

  it('never puts a query string on the stream URL, which Twilio rejects', async () => {
    const signature = signTwilio(AUTH_TOKEN, WEBHOOK_URL, CALL_PARAMS);
    const { body } = await post({ 'x-twilio-signature': signature });
    expect(body).not.toMatch(/url="[^"]*\?/);
  });

  it('hangs up cleanly on socket loss when no transfer number is set', async () => {
    const noTransfer = buildServer({
      ...collaborators(),
      config: config({ TRANSFER_NUMBER: '' }),
      sessionUpdate: {},
      connectRealtime: vi.fn(),
      control: { transfer: vi.fn(), hangup: vi.fn() },
    });
    const signature = signTwilio(AUTH_TOKEN, WEBHOOK_URL, CALL_PARAMS);

    const { body } = await noTransfer.app.inject({
      method: 'POST',
      url: '/incoming-call',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': signature,
      },
      payload: formBody(CALL_PARAMS),
    });
    await noTransfer.app.close();

    expect(body).toContain('<Hangup/>');
    expect(body).not.toContain('<Dial>');
  });

  it('fails readiness while draining but stays alive', async () => {
    server.startDraining();
    expect((await server.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    expect((await server.app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('is ready when not draining', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
  });

  it('reports health without a signature', async () => {
    const response = await server.app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', activeCalls: 0 });
  });
});

describe('/media-stream over real sockets', () => {
  let server: GatewayServer;
  let openai: WebSocketServer;
  let gatewayPort: number;
  let openaiHeaders: Record<string, string | string[] | undefined>;
  let openaiUrl: string;
  const openaiConnected = () =>
    new Promise<WebSocket>((resolve) => openai.once('connection', resolve));

  beforeEach(async () => {
    openai = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise((resolve) => openai.once('listening', resolve));
    openai.on('connection', (_socket, request) => {
      openaiHeaders = request.headers;
      openaiUrl = request.url ?? '';
    });

    const cfg = config();
    const { port } = openai.address() as AddressInfo;
    server = buildServer({
      ...collaborators(),
      config: cfg,
      sessionUpdate: buildSessionUpdate(cfg, 'test instructions'),
      connectRealtime: createRealtimeConnector({
        url: `ws://127.0.0.1:${port}/v1/realtime`,
        model: 'gpt-realtime-2.1-mini',
        apiKey: 'test-openai-key',
        log: silentLog,
      }),
      control: { transfer: vi.fn(async () => {}), hangup: vi.fn(async () => {}) },
    });
    await server.app.listen({ host: '127.0.0.1', port: 0 });
    gatewayPort = (server.app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    server.mediaStream.shutdown();
    await server.app.close();
    for (const client of openai.clients) client.terminate();
    await new Promise((resolve) => openai.close(resolve));
  });

  const connect = (signature?: string, path = '/media-stream') =>
    new WebSocket(`ws://127.0.0.1:${gatewayPort}${path}`, {
      headers: signature ? { 'x-twilio-signature': signature } : {},
    });

  const upgradeStatus = (socket: WebSocket) =>
    new Promise<number>((resolve, reject) => {
      socket.on('open', () => reject(new Error('the upgrade should have been refused')));
      socket.on('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
      socket.on('error', () => {});
    });

  const opened = (socket: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('error', reject);
    });

  it('refuses a forged signature before opening a socket', async () => {
    expect(await upgradeStatus(connect('forged'))).toBe(403);
  });

  it('refuses a missing signature', async () => {
    expect(await upgradeStatus(connect())).toBe(403);
  });

  it('refuses a signature for a different URL', async () => {
    const signature = signTwilio(AUTH_TOKEN, 'wss://evil.example.test/media-stream');
    expect(await upgradeStatus(connect(signature))).toBe(403);
  });

  it('refuses other paths', async () => {
    const signature = signTwilio(AUTH_TOKEN, STREAM_URL);
    expect(await upgradeStatus(connect(signature, '/not-here'))).toBe(404);
  });

  it.each([
    ['wss URL', STREAM_URL],
    ['wss URL with a trailing slash', `${STREAM_URL}/`],
    ['https URL', `${PUBLIC_URL}/media-stream`],
    ['https URL with a trailing slash', `${PUBLIC_URL}/media-stream/`],
  ])('accepts a signature over the %s', async (_name, url) => {
    const socket = connect(signTwilio(AUTH_TOKEN, url));
    await opened(socket);
    socket.close();
  });

  it('carries a call end to end through both sockets', async () => {
    const twilio = connect(signTwilio(AUTH_TOKEN, STREAM_URL));
    const fromGateway: Record<string, unknown>[] = [];
    twilio.on('message', (data) => fromGateway.push(JSON.parse(data.toString())));
    await opened(twilio);

    // Twilio starts the stream, and the gateway dials OpenAI.
    const openaiPeer = openaiConnected();
    twilio.send(JSON.stringify({ event: 'connected' }));
    twilio.send(
      JSON.stringify({
        event: 'start',
        streamSid: STREAM_SID,
        start: {
          streamSid: STREAM_SID,
          callSid: CALL_SID,
          customParameters: { from: '+15550001111' },
        },
      }),
    );
    const realtime = await openaiPeer;
    const fromClient: Record<string, unknown>[] = [];
    realtime.on('message', (data) => fromClient.push(JSON.parse(data.toString())));

    // The connection is authenticated and selects the model, with no beta header.
    expect(openaiHeaders.authorization).toBe('Bearer test-openai-key');
    expect(openaiHeaders['openai-beta']).toBeUndefined();
    expect(openaiUrl).toContain('model=gpt-realtime-2.1-mini');

    // The session is configured for telephony audio.
    const sessionUpdate = await nextMessage(
      fromClient,
      realtime,
      (event) => event.type === 'session.update',
    );
    expect(sessionUpdate).toMatchObject({
      session: {
        audio: {
          input: { format: { type: 'audio/pcmu' } },
          output: { format: { type: 'audio/pcmu' } },
        },
      },
    });

    // Once ready, the agent greets the caller.
    realtime.send(JSON.stringify({ type: 'session.updated' }));
    await nextMessage(fromClient, realtime, (event) => event.type === 'response.create');

    // Agent audio reaches the caller.
    realtime.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
    realtime.send(
      JSON.stringify({
        type: 'response.output_audio.delta',
        response_id: 'resp_1',
        item_id: 'item_1',
        delta: audioOfMs(1000),
      }),
    );
    const media = await nextMessage(fromGateway, twilio, (message) => message.event === 'media');
    expect(media).toEqual({
      event: 'media',
      streamSid: STREAM_SID,
      media: { payload: audioOfMs(1000) },
    });

    // Caller audio reaches OpenAI.
    twilio.send(
      JSON.stringify({
        event: 'media',
        media: { track: 'inbound', timestamp: '400', payload: 'Y2FsbGVy' },
      }),
    );
    const appended = await nextMessage(
      fromClient,
      realtime,
      (event) => event.type === 'input_audio_buffer.append',
    );
    expect(appended.audio).toBe('Y2FsbGVy');

    // The caller interrupts, and buffered audio is cleared.
    realtime.send(JSON.stringify({ type: 'input_audio_buffer.speech_started' }));
    await nextMessage(fromGateway, twilio, (message) => message.event === 'clear');
    await nextMessage(fromClient, realtime, (event) => event.type === 'response.cancel');
    const truncate = await nextMessage(
      fromClient,
      realtime,
      (event) => event.type === 'conversation.item.truncate',
    );
    // Playback began at stream time 0 and the latest media frame was at 400 ms.
    expect(truncate.audio_end_ms).toBe(400);

    expect(server.mediaStream.activeCalls()).toBe(1);

    // The caller hangs up, and both sockets close.
    const realtimeClosed = new Promise((resolve) => realtime.once('close', resolve));
    twilio.send(JSON.stringify({ event: 'stop' }));
    await realtimeClosed;

    expect(server.mediaStream.activeCalls()).toBe(0);
  });
});
