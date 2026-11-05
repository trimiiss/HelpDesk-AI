import {
  contextFromHeaders,
  createEvent,
  emptyUsage,
  maskPhone,
  SpanKind,
  startSpan,
  traceHeaders,
  withSpan,
  type CallUsage,
  type Context,
  type HelpdeskEvent,
  type Logger,
  type Span,
} from '@helpdesk/shared';
import type { CallControl } from './callControl.js';
import type { SearchKnowledge } from './knowledgeClient.js';
import type { CallMetrics } from './metrics.js';
import type { RealtimeConnection, RealtimeConnector, RealtimeEvent } from './realtime.js';
import { MESSAGE_TOOL, SEARCH_TOOL, TRANSFER_TOOL } from './session.js';
import type { TwilioInbound, TwilioOutbound } from './twilioMessages.js';
import {
  addResponseUsage,
  addTranscriptionUsage,
  type CostEstimator,
  type ResponseUsage,
  type TranscriptionUsage,
} from './usage.js';

/** G.711 mu-law is 8000 one-byte samples per second. */
const BYTES_PER_MS = 8;

/** After a REST update, how long to let Twilio close the stream before we do. */
const TWILIO_CLOSE_TIMEOUT_MS = 5000;

const MAX_NAME_LENGTH = 200;
const MAX_PHONE_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 2000;

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
  messageSaveTimeoutMs: number;
}

export interface TwilioPeer {
  send(message: TwilioOutbound): void;
  close(): void;
}

/** Where events go. Only `publishNow` can be awaited, and only when a caller depends on the result. */
export interface CallEvents {
  enqueue(event: HelpdeskEvent, headers: Record<string, string>): void;
  publishNow(
    event: HelpdeskEvent,
    headers: Record<string, string>,
    timeoutMs: number,
  ): Promise<void>;
}

export interface CallSessionDeps {
  twilio: TwilioPeer;
  connectRealtime: RealtimeConnector;
  control: CallControl;
  events: CallEvents;
  searchKnowledge: SearchKnowledge;
  metrics: CallMetrics;
  estimateCost: CostEstimator;
  /** Built once at startup and identical for every call, so the prompt cache can be reused. */
  sessionUpdate: Record<string, unknown>;
  model: string;
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

interface ResponseItem {
  type?: string;
  id?: string;
  role?: string;
  content?: { transcript?: string }[];
}

interface ResponseBody {
  id?: string;
  status?: string;
  status_details?: unknown;
  output?: ResponseItem[];
  usage?: ResponseUsage;
}

/** Decoded size of a base64 string, without decoding it on the audio path. */
function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length * 3) / 4 - padding;
}

function parseArguments(raw: string | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '{}');
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const textField = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.trim().slice(0, maxLength) : '';

/**
 * Bridges one phone call between Twilio and the OpenAI Realtime API.
 *
 * Audio passes through as base64 without being decoded, because both sides use
 * G.711 mu-law. Nothing on the audio path awaits anything: events go to an
 * in-memory queue, and tools run off to the side. Only the REST calls that end
 * or transfer a call wait for a reply, and by then the bridge carries no audio.
 */
export class CallSession {
  private readonly log: Logger;
  private readonly timers = new Set<NodeJS.Timeout>();

  private realtime: RealtimeConnection | undefined;
  private callSid: string | undefined;
  private streamSid: string | undefined;
  private callerNumber: string | undefined;
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

  private callSpan: Span | undefined;
  private callContext: Context | undefined;
  private readonly usage: CallUsage = emptyUsage();
  private speechStoppedAt: number | undefined;

  // Transcripts finish in any order, so each item's position is noted when it first appears.
  private readonly itemSequence = new Map<string, number>();
  private readonly publishedTranscripts = new Set<string>();
  private readonly truncatedItems = new Set<string>();

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

    const { callSid } = message.start;
    this.callSid = callSid;
    this.streamSid = message.start.streamSid ?? message.streamSid;
    this.startedAt = Date.now();

    const { from, to, traceparent } = message.start.customParameters ?? {};
    this.callerNumber = from;
    this.log.info({ callSid, from: maskPhone(from), to }, 'call started');

    // The webhook may have run on another pod, so its trace arrives as a parameter.
    const { span, context } = startSpan('call', {
      kind: SpanKind.SERVER,
      parent: traceparent ? contextFromHeaders({ traceparent }) : undefined,
      attributes: { 'call.sid': callSid },
    });
    this.callSpan = span;
    this.callContext = context;

    this.deps.metrics.callStarted();
    this.publish(
      createEvent('call.started', callSid, {
        from,
        to,
        model: this.deps.model,
        traceId: span.spanContext().traceId,
      }),
    );

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
        this.speechStoppedAt = undefined;
        this.onCallerSpeechStarted();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.speechStoppedAt = Date.now();
        break;
      case 'input_audio_buffer.committed':
        this.noteItem(event.item_id);
        break;
      case 'conversation.item.added':
      case 'response.output_item.added':
        this.noteItem((event.item as ResponseItem | undefined)?.id);
        break;
      case 'response.done':
        this.onResponseDone((event.response ?? {}) as ResponseBody);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        addTranscriptionUsage(this.usage, event.usage as TranscriptionUsage | undefined);
        this.publishTranscript('caller', event.item_id, event.transcript);
        break;
      case 'response.output_audio_transcript.done':
        this.publishTranscript('agent', event.item_id, event.transcript);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        this.log.warn({ error: event.error }, 'caller transcription failed');
        this.deps.metrics.error('transcription');
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
    this.deps.metrics.error('realtime');
    // A rejected session.update would leave the wrong audio format on the line.
    if (!this.sessionReady) this.failToHuman(`session rejected: ${error.message ?? 'unknown'}`);
  }

  private onAudioDelta(event: RealtimeEvent): void {
    const { delta, item_id: itemId, response_id: responseId } = event;
    if (typeof delta !== 'string' || !this.streamSid) return;
    // Audio from a cancelled response can still arrive just after the barge-in.
    if (typeof responseId === 'string' && this.droppedResponses.has(responseId)) return;

    if (this.speechStoppedAt !== undefined) {
      this.deps.metrics.firstAudio((Date.now() - this.speechStoppedAt) / 1000);
      this.speechStoppedAt = undefined;
    }

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
      this.truncatedItems.add(this.assistant.itemId);
    }

    this.assistant = undefined;
    this.playbackCursorMs = this.latestMediaTimestamp;
  }

  private onResponseDone(response: ResponseBody): void {
    this.responseActive = false;
    this.currentResponseId = undefined;
    if (response.id) this.droppedResponses.delete(response.id);
    addResponseUsage(this.usage, response.usage);

    if (response.status === 'failed') {
      this.log.error({ details: response.status_details }, 'realtime response failed');
      this.deps.metrics.error('realtime_response');
    }

    // An interrupted response may never send its transcript event, so collect it here.
    for (const item of response.output ?? []) {
      if (item.type === 'message' && item.role === 'assistant') {
        const text = item.content?.map((part) => part.transcript ?? '').join(' ');
        this.publishTranscript('agent', item.id, text);
      }
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
    const pending: Promise<void>[] = [];

    for (const call of calls) {
      switch (call.name) {
        case TRANSFER_TOOL:
          this.startTransfer(call);
          break;
        case SEARCH_TOOL:
          pending.push(this.runSlowTool(call, (args) => this.searchKnowledge(args)));
          break;
        case MESSAGE_TOOL:
          pending.push(this.runSlowTool(call, (args) => this.takeMessage(args)));
          break;
        default:
          this.log.warn({ tool: call.name }, 'model called an unknown tool');
          this.deps.metrics.toolCall('unknown', 'error', 0);
          this.sendToolOutput(call, { ok: false, error: 'unknown_tool' });
      }
    }

    if (pending.length === 0) {
      this.requestResponse();
      return;
    }

    // These run beside the audio bridge, so the caller can keep talking meanwhile.
    void Promise.all(pending).then(() => {
      if (!this.ended && !this.leaving) this.requestResponse();
    });
  }

  private async runSlowTool(
    call: FunctionCallItem,
    run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): Promise<void> {
    const tool = call.name ?? 'unknown';
    const started = Date.now();

    const output = await withSpan(`tool ${tool}`, { parent: this.callContext }, async (span) => {
      const result = await run(parseArguments(call.arguments));
      if (result.error) span.setAttribute('tool.error', String(result.error));
      return result;
    }).catch((error: unknown) => {
      this.log.error({ err: error, tool }, 'tool failed');
      return { ok: false, error: 'tool_failed' };
    });

    this.deps.metrics.toolCall(tool, output.error ? 'error' : 'ok', (Date.now() - started) / 1000);
    if (output.error) this.deps.metrics.error(`tool_${tool}`);
    if (!this.ended && !this.leaving) this.sendToolOutput(call, output);
  }

  private async searchKnowledge(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const query = textField(args.query, 500);
    if (!query) return { found: false, results: [], error: 'empty_query' };

    try {
      return { ...(await this.deps.searchKnowledge(query)) };
    } catch (error) {
      this.log.error({ err: error }, 'knowledge search failed');
      return { found: false, results: [], error: 'search_unavailable' };
    }
  }

  /** The agent only tells the caller it worked if the broker confirmed it stored the message. */
  private async takeMessage(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const name = textField(args.name, MAX_NAME_LENGTH);
    const message = textField(args.message, MAX_MESSAGE_LENGTH);
    const phone = textField(args.phone, MAX_PHONE_LENGTH) || this.callerNumber;

    if (!name || !message) return { ok: false, error: 'missing_name_or_message' };
    if (!phone) return { ok: false, error: 'missing_phone' };
    if (!this.callSid) return { ok: false, error: 'not_saved' };

    try {
      await this.deps.events.publishNow(
        createEvent('message.taken', this.callSid, { name, phone, message }),
        traceHeaders(this.callContext),
        this.deps.timing.messageSaveTimeoutMs,
      );
      return { ok: true };
    } catch (error) {
      this.log.error({ err: error }, 'could not save message');
      return { ok: false, error: 'not_saved' };
    }
  }

  private startTransfer(call: FunctionCallItem): void {
    if (!this.deps.transferAvailable) {
      this.deps.metrics.toolCall(TRANSFER_TOOL, 'unavailable', 0);
      this.sendToolOutput(call, { ok: false, error: 'transfer_unavailable' });
      return;
    }

    this.sendToolOutput(call, { ok: true, status: 'connecting' });
    if (this.transferState !== 'idle') return;

    this.log.info({ callSid: this.callSid }, 'transfer requested');
    this.deps.metrics.toolCall(TRANSFER_TOOL, 'ok', 0);
    this.transferState = 'announcing';

    if (this.callSid) {
      const reason = textField(parseArguments(call.arguments).reason, MAX_NAME_LENGTH);
      this.publish(createEvent('transfer.requested', this.callSid, { reason: reason || undefined }));
    }

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
    this.deps.metrics.error('realtime_session');

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
        this.deps.metrics.error('twilio_rest');
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

    if (this.callSid) {
      const costUsd = this.deps.estimateCost(this.usage);
      this.deps.metrics.callEnded(reason, durationMs / 1000, costUsd, this.usage);
      this.publish(
        createEvent('call.ended', this.callSid, {
          reason,
          durationMs,
          usage: this.usage,
          costUsd,
          traceId: this.callSpan?.spanContext().traceId,
        }),
      );
      this.callSpan?.setAttributes({
        'call.end_reason': reason,
        'call.duration_ms': durationMs,
        'call.cost_usd': costUsd,
      });
      this.callSpan?.end();
    }

    this.deps.onEnd?.(reason);
  }

  private publish(event: HelpdeskEvent): void {
    this.deps.events.enqueue(event, traceHeaders(this.callContext));
  }

  /** Numbers items in the order they first appear in the conversation. */
  private noteItem(itemId: unknown): void {
    if (typeof itemId === 'string' && !this.itemSequence.has(itemId)) {
      this.itemSequence.set(itemId, this.itemSequence.size + 1);
    }
  }

  private publishTranscript(role: 'caller' | 'agent', itemId: unknown, text: unknown): void {
    if (typeof itemId !== 'string' || typeof text !== 'string') return;
    const transcript = text.trim();
    if (!transcript || !this.callSid || this.publishedTranscripts.has(itemId)) return;

    this.publishedTranscripts.add(itemId);
    this.noteItem(itemId);

    if (this.deps.logTranscripts) this.log.info({ role, transcript }, 'transcript');

    this.publish(
      createEvent('transcript.completed', this.callSid, {
        itemId,
        role,
        text: transcript,
        sequence: this.itemSequence.get(itemId) ?? 0,
        interrupted: this.truncatedItems.has(itemId),
      }),
    );
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
