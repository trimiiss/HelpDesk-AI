import type { HelpdeskEvent } from '@helpdesk/shared';

export type MessageHeaders = Record<string, string>;

export interface PublishOptions {
  /** Trace context and the like. Travels with the message and its dead-letter copy. */
  headers?: MessageHeaders;
  /** How long to wait for the broker to confirm the message is stored. */
  timeoutMs?: number;
}

export interface DeliveryContext {
  /** 1 on first delivery, 2 on the first retry, and so on. */
  attempt: number;
  headers: MessageHeaders;
}

export type EventHandler = (event: HelpdeskEvent, delivery: DeliveryContext) => Promise<void>;

export interface SubscribeOptions {
  /** Consumers with the same name share progress, which survives restarts. */
  durableName: string;
  /** After this many failed deliveries, the message moves to the dead-letter subject. */
  maxAttempts: number;
  /** Wait before each retry. The last value repeats if there are more retries than values. */
  backoffMs: number[];
}

export interface Subscription {
  stop(): Promise<void>;
}

export interface DeadLetter {
  subject: string;
  payload: string;
  headers: MessageHeaders;
  error: string;
  attempts: number;
}

/**
 * The only thing services know about the broker. Delivery is at-least-once, so a
 * handler must be safe to run twice. A second implementation, such as RabbitMQ,
 * has to pass the same contract tests in test/contract.ts.
 */
export interface EventBus {
  /** Resolves only once the broker has durably stored the event. */
  publish(event: HelpdeskEvent, options?: PublishOptions): Promise<void>;
  subscribe(handler: EventHandler, options: SubscribeOptions): Promise<Subscription>;
  close(): Promise<void>;
}

export const backoffFor = (backoffMs: number[], attempt: number): number =>
  backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 0;
