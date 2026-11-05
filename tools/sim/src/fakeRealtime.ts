import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { BYTES_PER_MS, decodeCallerSpeech, encodeAgentSpeech } from './protocol.js';

interface ToolResult {
  name: string;
  output: Record<string, unknown>;
}

interface ActiveResponse {
  id: string;
  itemId: string;
  timer: NodeJS.Timeout | undefined;
  audioBytes: number;
  transcript: string;
}

const NOT_FOUND = "I don't have that information. I can connect you to a person or take a message.";

/** How fast fake audio arrives. Like the real API, it runs ahead of playback. */
const CHUNK_INTERVAL_MS = 40;

/** Matches the caller's words to the tool a real model would have chosen. */
function chooseTool(text: string): { name: string; args: Record<string, unknown> } {
  if (/\b(person|human|someone|njeri|mensch|mitarbeiter)\b/i.test(text)) {
    return { name: 'transfer_to_human', args: { reason: 'caller asked for a person' } };
  }
  if (/\b(message|mesazh|nachricht)\b/i.test(text)) {
    return {
      name: 'take_message',
      args: { name: 'Simulated Caller', message: text },
    };
  }
  return { name: 'search_knowledge', args: { query: text } };
}

/**
 * Stands in for the OpenAI Realtime API. It enforces the rules the real API
 * enforces, so a gateway bug shows up here as an error rather than on a real call:
 * only the GA session shape is accepted, only one response may run at a time, and
 * truncating past the audio sent is rejected.
 */
export class FakeRealtimeSession {
  private configured = false;
  private greeting = 'Hello.';
  private greeted = false;
  private goodbyePending = false;
  private active: ActiveResponse | undefined;
  private lastTool: ToolResult | undefined;
  private lastToolName = '';
  private readonly audioByItem = new Map<string, number>();

  constructor(private readonly socket: WebSocket) {
    this.send({ type: 'session.created', session: { type: 'realtime' } });
    socket.on('message', (data) => this.onMessage(JSON.parse(data.toString())));
    socket.on('close', () => this.stopActive());
  }

  private send(event: Record<string, unknown>): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify({ event_id: `event_${randomUUID()}`, ...event }));
    }
  }

  private error(message: string, code?: string): void {
    this.send({ type: 'error', error: { type: 'invalid_request_error', code, message } });
  }

  private onMessage(event: Record<string, unknown>): void {
    switch (event.type) {
      case 'session.update':
        this.onSessionUpdate(event.session as Record<string, unknown> | undefined);
        break;
      case 'conversation.item.create':
        this.onItem(event.item as Record<string, unknown>);
        break;
      case 'response.create':
        this.onResponseCreate();
        break;
      case 'response.cancel':
        this.finishActive('cancelled');
        break;
      case 'conversation.item.truncate':
        this.onTruncate(event);
        break;
      case 'input_audio_buffer.append':
        this.onAudio(String(event.audio));
        break;
      default:
        this.error(`unknown event type ${String(event.type)}`);
    }
  }

  private onSessionUpdate(session: Record<string, unknown> | undefined): void {
    const audio = session?.audio as
      | { input?: { format?: { type?: string } }; output?: { format?: { type?: string } } }
      | undefined;

    if (session?.type !== 'realtime') {
      this.error('session.type must be realtime');
      return;
    }
    if (audio?.input?.format?.type !== 'audio/pcmu' || audio.output?.format?.type !== 'audio/pcmu') {
      this.error('audio format must be audio/pcmu');
      return;
    }
    if ('input_audio_format' in (session ?? {})) {
      this.error('input_audio_format is not a GA field');
      return;
    }

    const instructions = String(session?.instructions ?? '');
    this.greeting = instructions.split('\n').pop() ?? this.greeting;
    this.configured = true;
    this.send({ type: 'session.updated', session });
  }

  private onItem(item: Record<string, unknown>): void {
    if (item.type === 'function_call_output') {
      this.lastTool = {
        name: this.lastToolName,
        output: JSON.parse(String(item.output)) as Record<string, unknown>,
      };
    } else if (item.role === 'system') {
      const content = item.content as { text?: string }[] | undefined;
      if (content?.[0]?.text?.includes('almost been reached')) this.goodbyePending = true;
    }
  }

  private onResponseCreate(): void {
    if (this.active) {
      this.error('a response is already active', 'conversation_already_has_active_response');
      return;
    }
    this.speak(this.nextLine());
  }

  private nextLine(): string {
    if (!this.greeted) {
      this.greeted = true;
      return this.greeting;
    }
    if (this.goodbyePending) {
      this.goodbyePending = false;
      return 'The call has to end now. Goodbye.';
    }

    const tool = this.lastTool;
    this.lastTool = undefined;

    switch (tool?.name) {
      case 'search_knowledge': {
        const results = tool.output.results as { text: string }[] | undefined;
        return tool.output.found && results?.[0] ? results[0].text : NOT_FOUND;
      }
      case 'take_message':
        return tool.output.ok
          ? 'Your message has been saved. Someone will call you back.'
          : 'I am sorry, your message could not be saved.';
      case 'transfer_to_human':
        return tool.output.ok ? 'I am connecting you now.' : 'I am sorry, nobody can take the call.';
      default:
        return 'How else can I help?';
    }
  }

  private speak(text: string): void {
    const id = `resp_${randomUUID()}`;
    const itemId = `item_${randomUUID()}`;
    const chunks = encodeAgentSpeech(text);
    const active: ActiveResponse = {
      id,
      itemId,
      timer: undefined,
      audioBytes: 0,
      transcript: text,
    };
    this.active = active;

    this.send({ type: 'response.created', response: { id, status: 'in_progress' } });
    this.send({ type: 'response.output_item.added', response_id: id, item: { id: itemId, type: 'message' } });

    let index = 0;
    const next = () => {
      if (this.active !== active) return;
      const delta = chunks[index];
      if (delta === undefined) {
        this.send({
          type: 'response.output_audio_transcript.done',
          response_id: id,
          item_id: itemId,
          transcript: text,
        });
        this.finishActive('completed');
        return;
      }
      index += 1;
      active.audioBytes += Buffer.from(delta, 'base64').length;
      this.audioByItem.set(itemId, active.audioBytes);
      this.send({
        type: 'response.output_audio.delta',
        response_id: id,
        item_id: itemId,
        content_index: 0,
        output_index: 0,
        delta,
      });
      active.timer = setTimeout(next, CHUNK_INTERVAL_MS);
    };
    next();
  }

  private stopActive(): void {
    if (this.active?.timer) clearTimeout(this.active.timer);
    this.active = undefined;
  }

  private finishActive(status: 'completed' | 'cancelled', output: unknown[] = []): void {
    const active = this.active;
    if (!active) return;
    this.stopActive();

    this.send({
      type: 'response.done',
      response: {
        id: active.id,
        status,
        output,
        usage: {
          input_token_details: {
            text_tokens: 900,
            audio_tokens: 120,
            cached_tokens_details: { text_tokens: 800, audio_tokens: 40 },
          },
          output_token_details: {
            text_tokens: Math.ceil(active.transcript.length / 4),
            audio_tokens: Math.ceil(active.audioBytes / BYTES_PER_MS / 50),
          },
        },
      },
    });
  }

  private onTruncate(event: Record<string, unknown>): void {
    const itemId = String(event.item_id);
    const audioMs = (this.audioByItem.get(itemId) ?? 0) / BYTES_PER_MS;
    const requested = Number(event.audio_end_ms);

    if (!Number.isInteger(requested) || requested < 0 || requested > audioMs) {
      this.error(`audio_end_ms ${requested} is outside the ${audioMs} ms sent`);
      return;
    }
    this.send({ type: 'conversation.item.truncated', item_id: itemId, audio_end_ms: requested });
  }

  /** Server VAD. A marker in the audio stands in for the caller speaking. */
  private onAudio(payload: string): void {
    if (!this.configured) return;
    const text = decodeCallerSpeech(payload);
    if (text === undefined) return;

    const itemId = `item_${randomUUID()}`;
    this.send({ type: 'input_audio_buffer.speech_started', item_id: itemId, audio_start_ms: 0 });
    this.send({ type: 'input_audio_buffer.speech_stopped', item_id: itemId, audio_end_ms: 900 });
    this.send({ type: 'input_audio_buffer.committed', item_id: itemId, previous_item_id: null });
    this.send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      content_index: 0,
      transcript: text,
      usage: { type: 'duration', seconds: 2 },
    });

    // Turn detection starts a response by itself, which then calls a tool.
    setTimeout(() => this.respondToCaller(text), 30);
  }

  private respondToCaller(text: string): void {
    if (this.active) this.finishActive('cancelled');

    const { name, args } = chooseTool(text);
    const id = `resp_${randomUUID()}`;
    this.lastToolName = name;

    this.active = {
      id,
      itemId: `item_${randomUUID()}`,
      timer: undefined,
      audioBytes: 0,
      transcript: '',
    };
    this.send({ type: 'response.created', response: { id, status: 'in_progress' } });
    this.finishActive('completed', [
      {
        type: 'function_call',
        name,
        call_id: `call_${randomUUID()}`,
        arguments: JSON.stringify(args),
      },
    ]);
  }
}
