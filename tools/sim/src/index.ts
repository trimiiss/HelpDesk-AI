import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createLogger, parseEnv } from '@helpdesk/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { FakeRealtimeSession } from './fakeRealtime.js';
import { PHONE_PAGE } from './phonePage.js';
import { encodeCallerSpeech } from './protocol.js';
import { placeCall } from './twilioCaller.js';

const config = parseEnv(
  z.object({
    SIM_PORT: z.coerce.number().int().positive().default(9000),
    GATEWAY_URL: z.string().default('http://call-gateway:8080'),
    PUBLIC_BASE_URL: z.string().min(1),
    TWILIO_AUTH_TOKEN: z.string().min(1),
    TWILIO_ACCOUNT_SID: z.string().min(1),
    /** Shown on the browser phone, so it's clear which AI you're talking to. */
    SIM_AI: z.enum(['fake', 'real']).default('fake'),
  }),
);

const log = createLogger('sim');

interface CallUpdate {
  status?: string;
  twiml?: string;
}

/** Updates made through the fake Twilio REST API, read by whoever is running the call. */
const callUpdates = new Map<string, CallUpdate>();
const updateListeners = new Map<string, (update: CallUpdate) => void>();

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function handleTwilioRest(
  request: IncomingMessage,
  response: ServerResponse,
  callSid: string,
): Promise<void> {
  const expected = `Basic ${Buffer.from(`${config.TWILIO_ACCOUNT_SID}:${config.TWILIO_AUTH_TOKEN}`).toString('base64')}`;
  if (request.headers.authorization !== expected) {
    json(response, 401, { message: 'authenticate' });
    return;
  }

  const form = new URLSearchParams(await readBody(request));
  const update: CallUpdate = {
    status: form.get('Status') ?? undefined,
    twiml: form.get('Twiml') ?? undefined,
  };
  callUpdates.set(callSid, update);
  updateListeners.get(callSid)?.(update);
  log.info({ callSid, ...update }, 'fake Twilio: call updated');
  json(response, 200, { sid: callSid, status: update.status ?? 'in-progress' });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://sim');

  if (request.method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/') {
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(PHONE_PAGE.replace('__SIM_AI__', config.SIM_AI));
    return;
  }

  const rest = /^\/2010-04-01\/Accounts\/[^/]+\/Calls\/([^/]+)\.json$/.exec(url.pathname);
  if (request.method === 'POST' && rest?.[1]) {
    void handleTwilioRest(request, response, rest[1]);
    return;
  }

  const lookup = /^\/sim\/calls\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'GET' && lookup?.[1]) {
    json(response, 200, callUpdates.get(lookup[1]) ?? {});
    return;
  }

  json(response, 404, { error: 'not found' });
});

const realtimeSockets = new WebSocketServer({ noServer: true });
const phoneSockets = new WebSocketServer({ noServer: true });

realtimeSockets.on('connection', (socket) => new FakeRealtimeSession(socket));

/** The browser supplies its own audio frames, so unlike MediaPump this adds no silence of its own. */
class BrowserRelay {
  constructor(private readonly socket: WebSocket) {}

  sendMedia(payload: string, timestamp: number): void {
    this.send({ event: 'media', media: { track: 'inbound', timestamp: String(timestamp), payload } });
  }

  sendMark(name: string): void {
    this.send({ event: 'mark', mark: { name } });
  }

  stop(): void {
    this.send({ event: 'stop' });
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }

  private send(message: Record<string, unknown>): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

/** One browser tab is one phone call. Everything relays through here, because a browser can't sign. */
phoneSockets.on('connection', (browser: WebSocket) => {
  const notify = (message: Record<string, unknown>) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(message));
  };

  placeCall(
    {
      gatewayUrl: config.GATEWAY_URL,
      publicBaseUrl: config.PUBLIC_BASE_URL,
      authToken: config.TWILIO_AUTH_TOKEN,
    },
    '+10000000001',
    '+10000000002',
  )
    .then(({ callSid, socket }) => {
      const startedAt = Date.now();
      const relay = new BrowserRelay(socket);
      notify({ event: 'connected', callSid });

      updateListeners.set(callSid, (update) => {
        const number = /<Dial>([^<]+)<\/Dial>/.exec(update.twiml ?? '')?.[1];
        notify({ event: 'ended', detail: number ? `Transferred to ${number}` : 'Call ended by the agent' });
        relay.stop();
      });

      socket.on('message', (data) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(data.toString());
      });
      socket.on('close', () => {
        updateListeners.delete(callSid);
        notify({ event: 'ended', detail: 'Call ended' });
        browser.close();
      });

      browser.on('message', (data) => {
        const message = JSON.parse(data.toString()) as {
          event: string;
          payload?: string;
          name?: string;
          text?: string;
        };
        if (message.event === 'media' && message.payload) {
          relay.sendMedia(message.payload, Date.now() - startedAt);
        } else if (message.event === 'mark' && message.name) {
          relay.sendMark(message.name);
        } else if (message.event === 'say' && message.text) {
          relay.sendMedia(encodeCallerSpeech(message.text), Date.now() - startedAt);
        }
      });
      browser.on('close', () => relay.stop());
    })
    .catch((error: unknown) => {
      log.error({ err: error }, 'could not place the call');
      notify({ event: 'ended', detail: 'Could not reach the gateway' });
      browser.close();
    });
});

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url ?? '/', 'http://sim');

  if (pathname === '/v1/realtime') {
    if (!request.headers.authorization?.startsWith('Bearer ')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    realtimeSockets.handleUpgrade(request, socket, head, (ws) => realtimeSockets.emit('connection', ws));
  } else if (pathname === '/phone') {
    phoneSockets.handleUpgrade(request, socket, head, (ws) => phoneSockets.emit('connection', ws));
  } else {
    socket.destroy();
  }
});

server.listen(config.SIM_PORT, '0.0.0.0', () => {
  log.info({ port: config.SIM_PORT, ai: config.SIM_AI }, 'simulator listening');
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => process.exit(0));
}

