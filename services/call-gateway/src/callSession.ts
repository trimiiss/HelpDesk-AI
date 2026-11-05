import { maskPhone, type Logger } from '@helpdesk/shared';
import type { CallControl } from './callControl.js';
import type { RealtimeConnection, RealtimeConnector, RealtimeEvent } from './realtime.js';
import { TRANSFER_TOOL } from './session.js';
import type { TwilioInbound, TwilioOutbound } from './twilioMessages.js';

/** G.711 mu-law is 8000 one-byte samples per second. */
const BYTES_PER_MS = 8;

/** After a REST update, how long to let Twilio close the stream before we do. */
const TWILIO_CLOSE_TIMEOUT_MS = 5000;

const CALL_CONNECTED_MESSAGE = 'The call has connected. Say your greeting now.';
const GOODBYE_MESSAGE =
  'The maximum call length has almost been reached. In the language the caller is speaking, tell them the call has to end now and say goodbye in one short sentence.';

export type EndReason =
  | 'caller_hangup'
  | 'transferred'
  | 'transfer_failed'
  | 'max_duration'
  | 'realtime_failed'
  | 'setup_failed'
  | 'shutdown';

export interface CallTiming {
  maxCallMs: number;
  goodbyeLeadMs: number;
  sessionReadyTimeoutMs: number;
  transferPlaybackTimeoutMs: number;
}

export interface TwilioPeer {
  send(message: TwilioOutbound): void;
  close(): void;
}

export interface CallSessionDeps {
  twilio: TwilioPeer;
  connectRealtime: RealtimeConnector;
  control: CallControl;
  /** Built once at startup and identical for every call, so the prompt cache can be reused. */
  sessionUpdate: Record<string, unknown>;
  transferAvailable: boolean;
  timing: CallTiming;
  logTranscripts: boolean;
  log: Logger;
  onEnd?: (reason: EndReason) => void;
}

/** idle > announcing (model says it's connecting) > draining (audio finishes playing) */
type TransferState = 'idle' | 'announcing' | 'draining';

interface AssistantAudio {
  itemId: string;
  /** Twilio stream time at which this item starts playing to the caller. */
  startMs: number;
  bytes: number;
}

interface FunctionCallItem {
  type: 'function_call';
  name?: string;
  call_id?: string;
  arguments?: string;
}

interface ResponseBody {
  id?: string;
  status?: string;
  status_details?: unknown;
  output?: { type?: string }[];
}

/** Decoded size of a base64 string, without decoding it on the audio path. */
function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

/**
 * Bridges one phone call between Twilio and the OpenAI Realtime API.
 *
 * Audio passes through as base64 without being decoded, because both sides use
 * G.711 mu-law. Nothing on the audio path awaits anything. Only the REST calls
 * that end or transfer a call are asynchronous, and they run once the bridge is
 * no longer carrying audio.
 */
export class CallSession {
  private readonly log: Logger;
  private readonly timers = new Set<NodeJS.Timeout>();

  private realtime: RealtimeConnection | undefined;
  private callSid: string | undefined;
  private streamSid: string | undefined;
  private sessionReady = false;
  private startedAt: number | undefined;

  private ended = false;
  /** A REST update is ending or moving the call, so the bridge is finished. */
  private leaving = false;
  private pendingEndReason: EndReason | undefined;

  // Twilio's media timestamps are the clock for what the caller has heard.
  private latestMediaTimestamp = 0;
  private playbackCursorMs = 0;
  private assistant: AssistantAudio | undefined;
  private pendingMarks = 0;
  private markCounter = 0;

  private responseActive = false;
  private responseQueued = false;
  private currentResponseId: string | undefined;
  private readonly droppedResponses = new Set<string>();

  private transferState: TransferState = 'idle';
  private transferTimer: NodeJS.Timeout | undefined;
  private readonly setupTimer: NodeJS.Timeout;

  constructor(private readonly deps: CallSessionDeps) {
    this.log = deps.log;
    this.setupTimer = this.schedule(
      () => this.failToHuman('session setup timed out'),
      deps.timing.sessionReadyTimeoutMs,
    );
  }

  handleTwilioMessage(raw: string): void {
    let message: TwilioInbound;
    try {
      message = JSON.parse(raw) as TwilioInbound;
    } catch {
      this.log.warn('ignored malformed message from Twilio');
      return;
    }

    switch (message.event) {
      case 'start':
        this.onStart(message);
        break;
      case 'media':
        this.onMedia(message);
        break;
      case 'mark':
        this.onMark();
        break;
      case 'stop':
        this.end(this.pendingEndReason ?? 'caller_hangup');
        break;
      default:
        break;
    }
  }

  handleTwilioClosed(): void {
    this.end(this.pendingEndReason ?? 'caller_hangup');
  }

  shutdown(): void {
    this.end('shutdown');
  }

  private onStart(message: Extract<TwilioInbound, { event: 'start' }>): void {
    if (this.callSid) return;

    this.callSid = message.start.callSid;
    this.streamSid = message.start.streamSid ?? message.streamSid;
    this.startedAt = Date.now();

    const { from, to } = message.start.customParameters ?? {};
    this.log.info({ callSid: this.callSid, from: maskPhone(from), to }, 'call started');

    const { maxCallMs, goodbyeLeadMs } = this.deps.timing;
    this.schedule(() => this.sayGoodbye(), maxCallMs - goodbyeLeadMs);
    this.schedule(() => this.hangUpAtLimit(), maxCallMs);

    this.realtime = this.deps.connectRealtime({
      onOpen: () => this.realtime?.send(this.deps.sessionUpdate),
      onEvent: (event) => this.onRealtimeEvent(event),
      onClose: (code, reason) => this.failToHuman(`realtime socket closed (${code} ${reason})`),
    });
  }

  private onMedia(message: Extract<TwilioInbound, { event: 'media' }>): void {
    const timestamp = Number(message.media.timestamp);
    if (Number.isFinite(timestamp)) this.latestMediaTimestamp = timestamp;

    if (message.media.track && message.media.track !== 'inbound') return;
    // Once the goodbye to the caller is playing, nothing they say should start a new turn.
    if (!this.sessionReady || this.leaving || this.transferState === 'draining') return;

    this.realtime?.send({ type: 'input_audio_buffer.append', audio: message.media.payload });
  }

  private onMark(): void {
    this.pendingMarks = Math.max(0, this.pendingMarks - 1);
    this.transferIfPlaybackFinished();
  }

  private onRealtimeEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'session.updated':
        this.onSessionReady();
        break;
      case 'response.created':
        this.responseActive = true;
        this.currentResponseId = (event.response as ResponseBody | undefined)?.id;
        break;
      case 'response.output_audio.delta':
        this.onAudioDelta(event);
        break;
      case 'input_audio_buffer.speech_started':
        this.onCallerSpeechStarted();
        break;
      case 'response.done':
        this.onResponseDone((event.response ?? {}) as ResponseBody);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        this.logTranscript('caller', event.transcript);
        break;
      case 'response.output_audio_transcript.done':
        this.logTranscript('agent', event.transcript);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.log.warn({ error: event.error }, 'caller transcription failed');
        break;
      case 'error':
        this.onRealtimeError(event);
        break;
      default:
        this.log.trace({ type: event.type }, 'unhandled realtime event');
    }
  }

  private onSessionReady(): void {
    if (this.sessionReady) return;
    this.sessionReady = true;
    this.cancelTimer(this.setupTimer);
    this.sendSystemMessage(CALL_CONNECTED_MESSAGE);
    this.requestResponse();
  }

  private onRealtimeError(event: RealtimeEvent): void {
    const error = (event.error ?? {}) as { code?: string | null; message?: string };

    if (error.code === 'conversation_already_has_active_response') {
      // Lost a race with a response started by turn detection. Try again when it finishes.
      this.responseQueued = true;
      return;
    }

    this.log.error({ error: event.error }, 'realtime error');
    // A rejected session.update would leave the wrong audio format on the line.
    if (!this.sessionReady) this.failToHuman(`session rejected: ${error.message ?? 'unknown'}`);
  }

  private onAudioDelta(event: RealtimeEvent): void {
    const { delta, item_id: itemId, response_id: responseId } = event;
    if (typeof delta !== 'string' || !this.streamSid) return;
    // Audio from a cancelled response can still arrive just after the barge-in.
    if (typeof responseId === 'string' && this.droppedResponses.has(responseId)) return;

    if (typeof itemId === 'string' && this.assistant?.itemId !== itemId) {
      // A new item queues behind any audio Twilio is still playing.
      const startMs = Math.max(this.latestMediaTimestamp, this.playbackCursorMs);
      this.assistant = { itemId, startMs, bytes: 0 };
      this.playbackCursorMs = startMs;
    }

    const bytes = base64ByteLength(delta);
    if (this.assistant) this.assistant.bytes += bytes;
    this.playbackCursorMs += bytes / BYTES_PER_MS;

    this.deps.twilio.send({
      event: 'media',
      streamSid: this.streamSid,
      media: { payload: delta },
    });
    this.deps.twilio.send({
      event: 'mark',
      streamSid: this.streamSid,
      mark: { name: `audio-${++this.markCounter}` },
    });
    this.pendingMarks += 1;
  }

  /**
   * Barge-in. Twilio buffers audio ahead of what the caller hears, so stopping
   * generation alone isn't enough: the buffer has to be cleared, and the model
   * told where the caller stopped hearing it, or it will assume they heard it all.
   */
  private onCallerSpeechStarted(): void {
    const playing = this.assistant !== undefined && this.pendingMarks > 0;
    if (!playing && !this.responseActive) return;

    if (playing && this.streamSid) {
      this.deps.twilio.send({ event: 'clear', streamSid: this.streamSid });
    }

    if (this.responseActive) {
      this.realtime?.send({ type: 'response.cancel' });
      if (this.currentResponseId) this.droppedResponses.add(this.currentResponseId);
    }

    if (playing && this.assistant) {
      // The API returns an error if audio_end_ms is longer than the audio it sent.
      const heardMs = this.latestMediaTimestamp - this.assistant.startMs;
      const sentMs = Math.floor(this.assistant.bytes / BYTES_PER_MS);
      this.realtime?.send({
        type: 'conversation.item.truncate',
        item_id: this.assistant.itemId,
        content_index: 0,
        audio_end_ms: Math.max(0, Math.min(Math.floor(heardMs), sentMs)),
      });
    }

    this.assistant = undefined;
    this.playbackCursorMs = this.latestMediaTimestamp;
  }

  private onResponseDone(response: ResponseBody): void {
    this.responseActive = false;
    this.currentResponseId = undefined;
    if (response.id) this.droppedResponses.delete(response.id);

    if (response.status === 'failed') {
      this.log.error({ details: response.status_details }, 'realtime response failed');
    }

    // The response that follows a transfer tool call is the "connecting you" line.
    if (this.transferState === 'announcing') {
      this.transferState = 'draining';
      this.transferIfPlaybackFinished();
    }

    // A cancelled response can hold half-formed tool calls, so only completed ones run.
    if (response.status === 'completed') {
      const calls = (response.output ?? []).filter(
        (item): item is FunctionCallItem => item.type === 'function_call',
      );
      if (calls.length > 0) this.runTools(calls);
    }

    if (this.responseQueued) {
      this.responseQueued = false;
      this.requestResponse();
    }
  }

  private runTools(calls: FunctionCallItem[]): void {
    for (const call of calls) {
      if (call.name === TRANSFER_TOOL) {
        this.startTransfer(call);
      } else {
        this.log.warn({ tool: call.name }, 'model called an unknown tool');
        this.sendToolOutput(call, { ok: false, error: 'unknown_tool' });
      }
    }
    this.requestResponse();
  }

  private startTransfer(call: FunctionCallItem): void {
    if (!this.deps.transferAvailable) {
      this.sendToolOutput(call, { ok: false, error: 'transfer_unavailable' });
      return;
    }

    this.sendToolOutput(call, { ok: true, status: 'connecting' });
    if (this.transferState !== 'idle') return;

    this.log.info({ callSid: this.callSid }, 'transfer requested');
    this.transferState = 'announcing';
    // Marks can be lost, so a stuck announcement must not strand the caller.
    this.transferTimer = this.schedule(
      () => this.endViaTwilio('transferred', 'transfer_failed'),
      this.deps.timing.transferPlaybackTimeoutMs,
    );
  }

  private transferIfPlaybackFinished(): void {
    if (this.transferState === 'draining' && this.pendingMarks === 0) {
      this.endViaTwilio('transferred', 'transfer_failed');
    }
  }

  private sayGoodbye(): void {
    if (this.leaving || this.transferState !== 'idle') return;
    this.sendSystemMessage(GOODBYE_MESSAGE);
    this.requestResponse();
  }

  private hangUpAtLimit(): void {
    // A transfer already underway ends the bridge on its own timer.
    if (this.transferState !== 'idle') return;
    this.log.info('maximum call length reached');
    this.endViaTwilio('max_duration', 'max_duration');
  }

  /** The AI is gone, so a person takes over if there is one. Dead air is never acceptable. */
  private failToHuman(detail: string): void {
    if (this.ended || this.leaving) return;
    this.log.error({ detail }, 'AI session failed, handing over the call');

    if (!this.callSid) {
      this.end('setup_failed');
      return;
    }
    this.endViaTwilio(
      this.deps.transferAvailable ? 'transferred' : 'realtime_failed',
      'realtime_failed',
    );
  }

  /**
   * Ends or transfers the call through Twilio's REST API. Twilio then closes the
   * stream itself. Closing it first would make Twilio run the fallback verb after
   * <Connect>, which could ring a person for a call that has already ended.
   */
  private endViaTwilio(success: EndReason, failure: EndReason): void {
    if (this.ended || this.leaving) return;
    this.leaving = true;
    this.cancelTimer(this.transferTimer);
    this.realtime?.close();

    const { callSid } = this;
    if (!callSid) {
      this.end(failure);
      return;
    }

    const action =
      success === 'transferred'
        ? this.deps.control.transfer(callSid)
        : this.deps.control.hangup(callSid);

    action.then(
      () => {
        this.pendingEndReason = success;
        this.schedule(() => this.end(success), TWILIO_CLOSE_TIMEOUT_MS);
      },
      (error: unknown) => {
        this.log.error({ err: error }, 'Twilio call update failed');
        // Closing the stream lets the <Dial> or <Hangup> after <Connect> take over.
        this.end(failure);
      },
    );
  }

  private end(reason: EndReason): void {
    if (this.ended) return;
    this.ended = true;

    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();

    this.realtime?.close();
    this.deps.twilio.close();

    const durationMs = this.startedAt === undefined ? 0 : Date.now() - this.startedAt;
    this.log.info({ callSid: this.callSid, reason, durationMs }, 'call ended');
    this.deps.onEnd?.(reason);
  }

  private requestResponse(): void {
    if (this.responseActive) {
      this.responseQueued = true;
      return;
    }
    // Set now, because response.created hasn't arrived yet and only one may run at a time.
    this.responseActive = true;
    this.realtime?.send({ type: 'response.create' });
  }

  /** Added to the conversation, so the cached instructions stay exactly as they were. */
  private sendSystemMessage(text: string): void {
    this.realtime?.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
    });
  }

  private sendToolOutput(call: FunctionCallItem, output: Record<string, unknown>): void {
    this.realtime?.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(output),
      },
    });
  }

  private logTranscript(role: 'caller' | 'agent', transcript: unknown): void {
    if (this.deps.logTranscripts) this.log.info({ role, transcript }, 'transcript');
  }

  private schedule(callback: () => void, delayMs: number): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, delayMs);
    this.timers.add(timer);
    return timer;
  }

  private cancelTimer(timer: NodeJS.Timeout | undefined): void {
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }
}
