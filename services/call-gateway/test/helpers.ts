import { createHmac } from 'node:crypto';
import { createLogger, type HelpdeskEvent } from '@helpdesk/shared';
import { vi } from 'vitest';
import { CallSession, type CallSessionDeps, type EndReason } from '../src/callSession.js';
import type { SearchKnowledge } from '../src/knowledgeClient.js';
import type { RealtimeEvent, RealtimeHandlers } from '../src/realtime.js';
import type { TwilioOutbound } from '../src/twilioMessages.js';

export const silentLog = createLogger('test', 'silent');

export const CALL_SID = 'CA00000000000000000000000000000001';
export const STREAM_SID = 'MZ00000000000000000000000000000001';

export const TIMING = {
  maxCallMs: 600_000,
  goodbyeLeadMs: 30_000,
  sessionReadyTimeoutMs: 5_000,
  transferPlaybackTimeoutMs: 8_000,
  messageSaveTimeoutMs: 3_000,
};

export function fakeMetrics() {
  return {
    callStarted: vi.fn(),
    callEnded: vi.fn(),
    firstAudio: vi.fn(),
    toolCall: vi.fn(),
    error: vi.fn(),
  };
}

/** Collects events and lets a test decide whether the broker accepts them. */
export function fakeEvents() {
  const queued: HelpdeskEvent[] = [];
  const headers: Record<string, string>[] = [];
  return {
    queued,
    headers,
    enqueue: vi.fn((event: HelpdeskEvent, eventHeaders: Record<string, string>) => {
      queued.push(event);
      headers.push(eventHeaders);
    }),
    publishNow: vi.fn(
      async (event: HelpdeskEvent, _headers: Record<string, string>, _timeoutMs: number) => {
        queued.push(event);
      },
    ),
    ofType<T extends HelpdeskEvent['type']>(type: T) {
      return queued.filter(
        (event): event is Extract<HelpdeskEvent, { type: T }> => event.type === type,
      );
    },
  };
}

export const SESSION_UPDATE = { type: 'session.update', session: { type: 'realtime' } };

/** Base64 mu-law audio lasting this many milliseconds (8 bytes per ms). */
export function audioOfMs(ms: number): string {
  return Buffer.alloc(ms * 8, 0xff).toString('base64');
}

/**
 * Twilio's signature scheme, written out here on purpose. If the tests used the
 * SDK to sign as well as verify, a wrong call to it could still pass.
 */
export function signTwilio(
  authToken: string,
  url: string,
  params: Record<string, string> = {},
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((data, key) => `${data}${key}${params[key]}`, url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

/**
 * A CallSession wired to fake peers. Everything sent to either side lands on one
 * timeline, because barge-in correctness depends on order across both sockets.
 */
export function createHarness(overrides: Partial<CallSessionDeps> = {}) {
  const timeline: string[] = [];
  const toTwilio: TwilioOutbound[] = [];
  const toOpenAI: Record<string, unknown>[] = [];
  const endReasons: EndReason[] = [];
  let handlers: RealtimeHandlers | undefined;
  let twilioCloses = 0;
  let realtimeCloses = 0;

  const control = {
    transfer: vi.fn(async (_callSid: string) => {}),
    hangup: vi.fn(async (_callSid: string) => {}),
  };
  const events = fakeEvents();
  const metrics = fakeMetrics();
  const searchKnowledge = vi.fn<SearchKnowledge>(async () => ({
    found: true,
    results: [{ text: 'We open at 8.', source: 'faq.md' }],
  }));

  const session = new CallSession({
    events,
    metrics,
    searchKnowledge,
    estimateCost: () => 0.25,
    model: 'test-model',
    twilio: {
      send(message) {
        toTwilio.push(message);
        timeline.push(`twilio:${message.event}`);
      },
      close() {
        twilioCloses += 1;
      },
    },
    connectRealtime: (realtimeHandlers) => {
      handlers = realtimeHandlers;
      return {
        send(event) {
          toOpenAI.push(event);
          timeline.push(`openai:${String(event.type)}`);
        },
        close() {
          realtimeCloses += 1;
        },
      };
    },
    control,
    sessionUpdate: SESSION_UPDATE,
    transferAvailable: true,
    timing: TIMING,
    logTranscripts: false,
    log: silentLog,
    onEnd: (reason) => endReasons.push(reason),
    ...overrides,
  });

  const twilio = (message: Record<string, unknown>) =>
    session.handleTwilioMessage(JSON.stringify(message));

  const openai = (event: RealtimeEvent) => {
    if (!handlers) throw new Error('realtime is not connected');
    handlers.onEvent(event);
  };

  const harness = {
    session,
    control,
    events,
    metrics,
    searchKnowledge,
    timeline,
    toTwilio,
    toOpenAI,
    endReasons,
    twilio,
    openai,
    get twilioCloses() {
      return twilioCloses;
    },
    get realtimeCloses() {
      return realtimeCloses;
    },
    get realtimeConnected() {
      return handlers !== undefined;
    },

    start() {
      twilio({
        event: 'start',
        streamSid: STREAM_SID,
        start: {
          streamSid: STREAM_SID,
          callSid: CALL_SID,
          customParameters: { from: '+15550001111', to: '+15550002222' },
        },
      });
    },

    openRealtime() {
      if (!handlers) throw new Error('realtime is not connected');
      handlers.onOpen();
    },

    closeRealtime(code = 1006, reason = 'lost') {
      if (!handlers) throw new Error('realtime is not connected');
      handlers.onClose(code, reason);
    },

    /** Runs a call up to the point where the agent is ready and the greeting has finished. */
    connectAndGreet() {
      harness.start();
      harness.openRealtime();
      openai({ type: 'session.updated' });
      openai({ type: 'response.created', response: { id: 'resp_greeting' } });
      openai({ type: 'response.done', response: { id: 'resp_greeting', status: 'completed' } });
      toOpenAI.length = 0;
      toTwilio.length = 0;
      timeline.length = 0;
    },

    /** Advances Twilio's stream clock, as its 20 ms media frames do on a live call. */
    mediaAt(timestampMs: number, payload = 'AAAA') {
      twilio({
        event: 'media',
        media: { track: 'inbound', timestamp: String(timestampMs), payload },
      });
    },

    agentAudio(itemId: string, ms: number, responseId = 'resp_1') {
      openai({
        type: 'response.output_audio.delta',
        response_id: responseId,
        item_id: itemId,
        delta: audioOfMs(ms),
      });
    },

    /** Twilio echoes one mark for each audio chunk it finished playing. */
    echoAllMarks() {
      for (const message of toTwilio) {
        if (message.event === 'mark') twilio({ event: 'mark', mark: message.mark });
      }
    },

    modelCallsTool(
      name: string,
      callId = 'call_1',
      status = 'completed',
      args: Record<string, unknown> = {},
    ) {
      openai({ type: 'response.created', response: { id: `resp_${callId}` } });
      openai({
        type: 'response.done',
        response: {
          id: `resp_${callId}`,
          status,
          output: [
            { type: 'function_call', name, call_id: callId, arguments: JSON.stringify(args) },
          ],
        },
      });
    },

    /** What the model was told a tool returned. */
    toolOutput(index = 0): Record<string, unknown> {
      const outputs = toOpenAI
        .map((event) => event.item as { type?: string; output?: string } | undefined)
        .filter((item) => item?.type === 'function_call_output');
      return JSON.parse(outputs[index]?.output ?? 'null') as Record<string, unknown>;
    },

    /** Runs the "connecting you now" response that follows a transfer tool call. */
    announceTransfer(audioMs = 1000) {
      openai({ type: 'response.created', response: { id: 'resp_announce' } });
      harness.agentAudio('item_announce', audioMs, 'resp_announce');
      openai({ type: 'response.done', response: { id: 'resp_announce', status: 'completed' } });
    },

    sentToOpenAI(type: string) {
      return toOpenAI.filter((event) => event.type === type);
    },
  };

  return harness;
}
