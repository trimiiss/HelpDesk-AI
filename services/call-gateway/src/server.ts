import formbody from '@fastify/formbody';
import type { Logger } from '@helpdesk/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import type { CallControl } from './callControl.js';
import type { GatewayConfig } from './config.js';
import { attachMediaStream, MEDIA_STREAM_PATH, type MediaStreamHandle } from './mediaStream.js';
import type { RealtimeConnector } from './realtime.js';
import { buildConnectTwiml } from './twiml.js';
import { isValidWebhook } from './twilioSignature.js';

export interface ServerDeps {
  config: GatewayConfig;
  log: Logger;
  sessionUpdate: Record<string, unknown>;
  connectRealtime: RealtimeConnector;
  control: CallControl;
}

export interface GatewayServer {
  app: FastifyInstance;
  mediaStream: MediaStreamHandle;
}

export function buildServer(deps: ServerDeps): GatewayServer {
  const { config, log } = deps;
  const app = Fastify();
  app.register(formbody);

  const mediaStream = attachMediaStream(app.server, {
    authToken: config.TWILIO_AUTH_TOKEN,
    publicBaseUrl: config.PUBLIC_BASE_URL,
    log,
    session: {
      connectRealtime: deps.connectRealtime,
      control: deps.control,
      sessionUpdate: deps.sessionUpdate,
      transferAvailable: config.TRANSFER_NUMBER !== undefined,
      logTranscripts: config.LOG_TRANSCRIPTS,
      timing: {
        maxCallMs: config.MAX_CALL_SECONDS * 1000,
        goodbyeLeadMs: config.GOODBYE_LEAD_SECONDS * 1000,
        sessionReadyTimeoutMs: config.SESSION_READY_TIMEOUT_MS,
        transferPlaybackTimeoutMs: config.TRANSFER_PLAYBACK_TIMEOUT_MS,
      },
    },
  });

  app.get('/healthz', async () => ({ status: 'ok', activeCalls: mediaStream.activeCalls() }));

  app.post('/incoming-call', async (request, reply) => {
    const params = (request.body ?? {}) as Record<string, string>;
    const header = request.headers['x-twilio-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const url = `${config.PUBLIC_BASE_URL}${request.url}`;

    if (!isValidWebhook(config.TWILIO_AUTH_TOKEN, signature, url, params)) {
      log.warn({ hasSignature: Boolean(signature) }, 'rejected webhook: bad signature');
      return reply.code(403).send();
    }

    // /media-stream may land on a different pod, so call details travel with the stream.
    const parameters: Record<string, string> = {};
    if (params.From) parameters.from = params.From;
    if (params.To) parameters.to = params.To;

    const twiml = buildConnectTwiml({
      streamUrl: `${config.PUBLIC_BASE_URL.replace(/^https:/, 'wss:')}${MEDIA_STREAM_PATH}`,
      parameters,
      transferNumber: config.TRANSFER_NUMBER,
    });

    return reply.type('text/xml').send(twiml);
  });

  return { app, mediaStream };
}
