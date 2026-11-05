import type { HelpdeskEvent, Logger } from '@helpdesk/shared';
import type { EventBus, MessageHeaders } from './eventBus.js';

export interface BufferedPublisherOptions {
  bus: EventBus;
  log: Logger;
  maxQueueSize?: number;
  retryDelayMs?: number;
  publishTimeoutMs?: number;
  onDrop?: () => void;
  onDepthChange?: (depth: number) => void;
}

interface QueuedEvent {
  event: HelpdeskEvent;
  headers: MessageHeaders;
}

/**
 * Keeps the broker off the audio path. `enqueue` only adds to an in-memory queue
 * and returns, so a slow or dead broker can't delay a call. The queue is bounded
 * so an outage can't exhaust memory: past the limit the oldest events are dropped
 * and counted, because a lost log entry is better than a lost call.
 */
export class BufferedPublisher {
  private readonly queue: QueuedEvent[] = [];
  private readonly maxQueueSize: number;
  private readonly retryDelayMs: number;
  private readonly publishTimeoutMs: number;
  private draining: Promise<void> | undefined;
  private stopped = false;
  private warned = false;

  constructor(private readonly options: BufferedPublisherOptions) {
    this.maxQueueSize = options.maxQueueSize ?? 10_000;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 2000;
  }

  /** Never blocks and never throws. */
  enqueue(event: HelpdeskEvent, headers: MessageHeaders = {}): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
      this.options.onDrop?.();
    }
    this.queue.push({ event, headers });
    this.options.onDepthChange?.(this.queue.length);
    this.draining ??= this.drain().finally(() => {
      this.draining = undefined;
    });
  }

  /** For events the caller is waiting on. Rejects unless the broker confirms it stored the event. */
  async publishNow(event: HelpdeskEvent, headers: MessageHeaders, timeoutMs: number): Promise<void> {
    await this.options.bus.publish(event, { headers, timeoutMs });
  }

  depth(): number {
    return this.queue.length;
  }

  /** Waits for the queue to empty, up to a limit, so a clean shutdown loses nothing. */
  async flush(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.stopped = true;
    if (this.queue.length > 0) {
      this.options.log.error({ lost: this.queue.length }, 'shut down with unsent events');
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const next = this.queue[0];
      if (!next) break;

      try {
        await this.options.bus.publish(next.event, {
          headers: next.headers,
          timeoutMs: this.publishTimeoutMs,
        });
        // Compare first: while waiting, overflow may have dropped this entry.
        if (this.queue[0] === next) this.queue.shift();
        this.options.onDepthChange?.(this.queue.length);
        if (this.warned) {
          this.warned = false;
          this.options.log.info('broker is back, sending queued events');
        }
      } catch (error) {
        if (!this.warned) {
          this.warned = true;
          this.options.log.warn({ err: error }, 'broker unavailable, queueing events');
        }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }
}
