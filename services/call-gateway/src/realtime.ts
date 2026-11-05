import type { Logger } from '@helpdesk/shared';
import WebSocket from 'ws';

export interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface RealtimeHandlers {
  onOpen(): void;
  onEvent(event: RealtimeEvent): void;
  onClose(code: number, reason: string): void;
}

export interface RealtimeConnection {
  send(event: Record<string, unknown>): void;
  close(): void;
}

export type RealtimeConnector = (handlers: RealtimeHandlers) => RealtimeConnection;

export interface RealtimeConnectorOptions {
  url: string;
  model: string;
  apiKey: string;
  log: Logger;
}

export function createRealtimeConnector(options: RealtimeConnectorOptions): RealtimeConnector {
  return (handlers) => {
    const endpoint = new URL(options.url);
    endpoint.searchParams.set('model', options.model);

    const socket = new WebSocket(endpoint, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });

    socket.on('open', () => handlers.onOpen());

    socket.on('message', (data) => {
      // One bad event must not take down a process that is serving other calls.
      try {
        handlers.onEvent(JSON.parse(data.toString()) as RealtimeEvent);
      } catch (error) {
        options.log.error({ err: error }, 'failed to handle realtime event');
      }
    });

    // 'close' always follows 'error', and that is where failure is handled.
    socket.on('error', (error) => options.log.error({ err: error }, 'realtime socket error'));
    socket.on('close', (code, reason) => handlers.onClose(code, reason.toString()));

    return {
      send(event) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      },
      close() {
        socket.close();
      },
    };
  };
}
