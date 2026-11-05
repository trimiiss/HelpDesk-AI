import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from '@helpdesk/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { CallSession, type CallSessionDeps, type TwilioPeer } from './callSession.js';
import { matchWebSocketSignature } from './twilioSignature.js';

export const MEDIA_STREAM_PATH = '/media-stream';

/** Twilio's media frames are small, so anything near this size isn't from Twilio. */
const MAX_FRAME_BYTES = 1024 * 1024;

export interface MediaStreamOptions {
  authToken: string;
  publicBaseUrl: string;
  log: Logger;
  session: Omit<CallSessionDeps, 'twilio' | 'onEnd' | 'log'>;
}

export interface MediaStreamHandle {
  activeCalls(): number;
  shutdown(): void;
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Handles the WebSocket upgrade directly, so a bad signature is refused before any socket opens. */
export function attachMediaStream(server: Server, options: MediaStreamOptions): MediaStreamHandle {
  const { log } = options;
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const sessions = new Set<CallSession>();

  const startSession = (socket: WebSocket): void => {
    const twilio: TwilioPeer = {
      send(message) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
      },
      close() {
        socket.close();
      },
    };

    const session = new CallSession({
      ...options.session,
      twilio,
      log,
      onEnd: () => sessions.delete(session),
    });
    sessions.add(session);

    socket.on('message', (data) => {
      // One bad message must not take down a process that is serving other calls.
      try {
        session.handleTwilioMessage(data.toString());
      } catch (error) {
        log.error({ err: error }, 'failed to handle Twilio message');
      }
    });
    socket.on('close', () => session.handleTwilioClosed());
    socket.on('error', (error) => log.warn({ err: error }, 'Twilio socket error'));
  };

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '/', 'http://localhost');
    if (pathname !== MEDIA_STREAM_PATH && pathname !== `${MEDIA_STREAM_PATH}/`) {
      rejectUpgrade(socket, '404 Not Found');
      return;
    }

    const header = request.headers['x-twilio-signature'];
    const signature = Array.isArray(header) ? header[0] : header;
    const signedUrl = matchWebSocketSignature(
      options.authToken,
      signature,
      options.publicBaseUrl,
      pathname,
    );

    if (!signedUrl) {
      log.warn({ hasSignature: Boolean(signature) }, 'rejected media stream: bad signature');
      rejectUpgrade(socket, '403 Forbidden');
      return;
    }

    log.info({ signedUrl }, 'media stream signature verified');
    webSockets.handleUpgrade(request, socket, head, startSession);
  });

  return {
    activeCalls: () => sessions.size,
    shutdown() {
      for (const session of sessions) session.shutdown();
      webSockets.close();
    },
  };
}
