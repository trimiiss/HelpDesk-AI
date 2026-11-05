import {
  AckPolicy,
  DeliverPolicy,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
} from '@nats-io/jetstream';
import { connect, headers as natsHeaders, type MsgHdrs, type NatsConnection } from '@nats-io/transport-node';
import {
  DEAD_LETTER_SUBJECT_PREFIX,
  EVENT_SUBJECT_PREFIX,
  eventSchema,
  subjectFor,
  type HelpdeskEvent,
  type Logger,
} from '@helpdesk/shared';
import {
  backoffFor,
  type EventBus,
  type EventHandler,
  type MessageHeaders,
  type PublishOptions,
  type SubscribeOptions,
  type Subscription,
} from './eventBus.js';

const STREAM = 'HELPDESK';
const DEAD_LETTER_STREAM = 'HELPDESK_DLQ';
const DAY_NS = 86_400_000_000_000;
const SECOND_NS = 1_000_000_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 5000;
/** Long enough for an email to send, so slow work isn't redelivered while it's still running. */
const ACK_WAIT_NS = 60 * SECOND_NS;

const HEADER_ERROR = 'x-helpdesk-error';
const HEADER_ATTEMPTS = 'x-helpdesk-attempts';

export interface NatsEventBusOptions {
  url: string;
  log: Logger;
  /** Called with the dead-letter subject each time a message gives up. */
  onDeadLetter?: (subject: string) => void;
}

interface Connected {
  connection: NatsConnection;
  client: JetStreamClient;
  manager: JetStreamManager;
}

function toNatsHeaders(values: MessageHeaders): MsgHdrs {
  const result = natsHeaders();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}

function fromNatsHeaders(values: MsgHdrs | undefined): MessageHeaders {
  const result: MessageHeaders = {};
  if (!values) return result;
  for (const key of values.keys()) result[key] = values.get(key);
  return result;
}

export class NatsEventBus implements EventBus {
  private readonly log: Logger;
  private readonly ready: Promise<Connected>;
  private closed = false;

  /** Returns straight away and connects in the background, so a NATS outage never blocks startup. */
  constructor(private readonly options: NatsEventBusOptions) {
    this.log = options.log;
    this.ready = this.connectWithRetry();
    this.ready.catch(() => {});
  }

  async publish(event: HelpdeskEvent, options: PublishOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
    const { client } = await this.readyWithin(timeoutMs);
    await client.publish(subjectFor(event.type), JSON.stringify(event), {
      // JetStream drops a repeat of this ID, so retrying a publish is always safe.
      msgID: event.eventId,
      headers: toNatsHeaders(options.headers ?? {}),
      timeout: timeoutMs,
    });
  }

  /** Puts raw bytes on a subject, to test what happens with malformed messages. */
  async publishRaw(subject: string, payload: string, headers: MessageHeaders = {}): Promise<void> {
    const { client } = await this.ready;
    await client.publish(subject, payload, { headers: toNatsHeaders(headers) });
  }

  async subscribe(handler: EventHandler, options: SubscribeOptions): Promise<Subscription> {
    const { client, manager } = await this.ready;

    // A backstop only. The handler below moves a message to the dead-letter
    // subject first, but a crash loop must not redeliver forever.
    const maxDeliver = options.maxAttempts + 2;

    await manager.consumers
      .add(STREAM, {
        durable_name: options.durableName,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        filter_subject: `${EVENT_SUBJECT_PREFIX}.>`,
        ack_wait: ACK_WAIT_NS,
        max_deliver: maxDeliver,
      })
      // The consumer survives restarts, so a changed setting has to be applied to it.
      .catch(() =>
        manager.consumers.update(STREAM, options.durableName, {
          ack_wait: ACK_WAIT_NS,
          max_deliver: maxDeliver,
        }),
      );

    const consumer = await client.consumers.get(STREAM, options.durableName);
    const messages = await consumer.consume({ max_messages: 20 });

    const loop = (async () => {
      for await (const message of messages) {
        await this.process(message, handler, options);
      }
    })();

    return {
      stop: async () => {
        await messages.close();
        await loop;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const { connection } = await this.readyWithin(1000).catch(() => ({ connection: undefined }));
    await connection?.drain();
  }

  private async process(
    message: JsMsg,
    handler: EventHandler,
    options: SubscribeOptions,
  ): Promise<void> {
    const attempt = message.info.deliveryCount;
    const headers = fromNatsHeaders(message.headers);

    let event: HelpdeskEvent;
    try {
      event = eventSchema.parse(message.json());
    } catch (error) {
      // Retrying can't fix a malformed message, so it goes straight to the dead letters.
      await this.deadLetter(message, headers, `invalid event: ${String(error)}`, attempt);
      return;
    }

    try {
      await handler(event, { attempt, headers });
      message.ack();
    } catch (error) {
      if (attempt >= options.maxAttempts) {
        this.log.error({ err: error, subject: message.subject, attempt }, 'giving up on event');
        await this.deadLetter(message, headers, String(error), attempt);
        return;
      }
      this.log.warn({ err: error, subject: message.subject, attempt }, 'retrying event');
      message.nak(backoffFor(options.backoffMs, attempt));
    }
  }

  /** The dead letter is stored before the original is dropped, so a failure here loses nothing. */
  private async deadLetter(
    message: JsMsg,
    headers: MessageHeaders,
    error: string,
    attempts: number,
  ): Promise<void> {
    const subject = `${DEAD_LETTER_SUBJECT_PREFIX}.${message.subject.slice(EVENT_SUBJECT_PREFIX.length + 1)}`;
    try {
      const { client } = await this.ready;
      await client.publish(subject, message.data, {
        headers: toNatsHeaders({
          ...headers,
          [HEADER_ERROR]: error.slice(0, 500).replace(/[\r\n]+/g, ' '),
          [HEADER_ATTEMPTS]: String(attempts),
        }),
      });
      message.term();
      this.options.onDeadLetter?.(subject);
    } catch (publishError) {
      this.log.error({ err: publishError, subject }, 'could not store dead letter, will redeliver');
      message.nak(5000);
    }
  }

  private async readyWithin(timeoutMs: number): Promise<Connected> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('not connected to NATS')), timeoutMs);
    });
    try {
      return await Promise.race([this.ready, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async connectWithRetry(): Promise<Connected> {
    const connection = await connect({
      servers: this.options.url,
      waitOnFirstConnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
      name: 'helpdesk',
    });

    // JetStream can lag behind the server accepting connections.
    for (;;) {
      try {
        const manager = await jetstreamManager(connection);
        await this.provisionStreams(manager);
        this.log.info({ url: this.options.url }, 'connected to NATS');
        return { connection, manager, client: jetstream(connection) };
      } catch (error) {
        if (this.closed) throw error;
        this.log.warn({ err: error }, 'waiting for JetStream');
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async provisionStreams(manager: JetStreamManager): Promise<void> {
    await manager.streams.add({
      name: STREAM,
      subjects: [`${EVENT_SUBJECT_PREFIX}.>`],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      max_age: 7 * DAY_NS,
      duplicate_window: 120 * SECOND_NS,
    });
    await manager.streams.add({
      name: DEAD_LETTER_STREAM,
      subjects: [`${DEAD_LETTER_SUBJECT_PREFIX}.>`],
      storage: StorageType.File,
      retention: RetentionPolicy.Limits,
      max_age: 30 * DAY_NS,
    });
  }
}
