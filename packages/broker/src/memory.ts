import { eventSchema, subjectFor, type HelpdeskEvent } from '@helpdesk/shared';
import {
  backoffFor,
  type DeadLetter,
  type EventBus,
  type EventHandler,
  type MessageHeaders,
  type PublishOptions,
  type SubscribeOptions,
  type Subscription,
} from './eventBus.js';

interface Message {
  subject: string;
  payload: string;
  headers: MessageHeaders;
  msgId: string | undefined;
}

/**
 * Same delivery rules as NATS, held in memory. Used by unit tests, and to show
 * that services depend on the interface rather than on a particular broker.
 */
export class MemoryEventBus implements EventBus {
  readonly deadLetters: DeadLetter[] = [];
  private readonly seenIds = new Set<string>();
  private readonly history: Message[] = [];
  private handlers: { handler: EventHandler; options: SubscribeOptions }[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();

  async publish(event: HelpdeskEvent, options: PublishOptions = {}): Promise<void> {
    if (this.seenIds.has(event.eventId)) return;
    this.seenIds.add(event.eventId);
    this.deliverToAll({
      subject: subjectFor(event.type),
      payload: JSON.stringify(event),
      headers: options.headers ?? {},
      msgId: event.eventId,
    });
  }

  /** Puts raw bytes on a subject, to test what happens with malformed messages. */
  publishRaw(subject: string, payload: string, headers: MessageHeaders = {}): void {
    this.deliverToAll({ subject, payload, headers, msgId: undefined });
  }

  async subscribe(handler: EventHandler, options: SubscribeOptions): Promise<Subscription> {
    const entry = { handler, options };
    this.handlers.push(entry);
    for (const message of this.history) this.deliver(entry, message, 1);
    return {
      stop: async () => {
        this.handlers = this.handlers.filter((candidate) => candidate !== entry);
      },
    };
  }

  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.handlers = [];
  }

  private deliverToAll(message: Message): void {
    this.history.push(message);
    for (const entry of this.handlers) this.deliver(entry, message, 1);
  }

  private deliver(
    entry: { handler: EventHandler; options: SubscribeOptions },
    message: Message,
    attempt: number,
  ): void {
    const parsed = (() => {
      try {
        return eventSchema.safeParse(JSON.parse(message.payload));
      } catch {
        return { success: false as const };
      }
    })();

    if (!parsed.success) {
      this.deadLetter(message, 'invalid event', attempt);
      return;
    }

    entry.handler(parsed.data, { attempt, headers: message.headers }).catch((error: unknown) => {
      if (attempt >= entry.options.maxAttempts) {
        this.deadLetter(message, String(error), attempt);
        return;
      }
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        this.deliver(entry, message, attempt + 1);
      }, backoffFor(entry.options.backoffMs, attempt));
      this.timers.add(timer);
    });
  }

  private deadLetter(message: Message, error: string, attempts: number): void {
    this.deadLetters.push({
      subject: message.subject,
      payload: message.payload,
      headers: message.headers,
      error,
      attempts,
    });
  }
}
