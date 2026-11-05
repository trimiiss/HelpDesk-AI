import { randomUUID } from 'node:crypto';
import { createEvent, type HelpdeskEvent } from '@helpdesk/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EventBus, EventHandler, SubscribeOptions, Subscription } from '../src/index.js';

export interface BusFixture {
  bus: EventBus;
  /** Sends bytes that aren't a valid event. */
  publishRaw(subject: string, payload: string): Promise<void>;
  /** Waits for a dead letter whose subject contains this text, and returns its details. */
  waitForDeadLetter(match: string): Promise<{ error: string; attempts: number; headers: Record<string, string> }>;
  cleanup(): Promise<void>;
}

const options = (overrides: Partial<SubscribeOptions> = {}): SubscribeOptions => ({
  durableName: `contract-${randomUUID()}`,
  maxAttempts: 3,
  backoffMs: [10],
  ...overrides,
});

async function waitUntil(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const started = (callSid = `CA${randomUUID()}`) => createEvent('call.started', callSid, { model: 'm' });

/**
 * The behaviour any EventBus must have. An implementation for another broker
 * passes this suite, or it isn't a drop-in replacement.
 */
export function eventBusContract(name: string, createFixture: () => Promise<BusFixture>): void {
  describe(`EventBus contract: ${name}`, () => {
    let fixture: BusFixture;
    let subscription: Subscription | undefined;

    /** Subscribes, ignoring anything other than this test's own events. */
    const subscribe = async (
      callSid: string,
      handler: EventHandler,
      overrides?: Partial<SubscribeOptions>,
    ) => {
      subscription = await fixture.bus.subscribe(async (event, delivery) => {
        if (event.callSid === callSid) await handler(event, delivery);
      }, options(overrides));
    };

    beforeEach(async () => {
      fixture = await createFixture();
    });

    afterEach(async () => {
      await subscription?.stop();
      subscription = undefined;
      await fixture.cleanup();
    });

    it('delivers a published event', async () => {
      const event = started();
      const received: HelpdeskEvent[] = [];
      await subscribe(event.callSid, async (delivered) => {
        received.push(delivered);
      });

      await fixture.bus.publish(event);

      await waitUntil(() => received.length === 1, 'delivery');
      expect(received[0]).toEqual(event);
    });

    it('delivers events published before the consumer started', async () => {
      const event = started();
      await fixture.bus.publish(event);

      const received: HelpdeskEvent[] = [];
      await subscribe(event.callSid, async (delivered) => {
        received.push(delivered);
      });

      await waitUntil(() => received.length === 1, 'delivery of an earlier event');
    });

    it('carries headers through to the handler', async () => {
      const event = started();
      let headers: Record<string, string> = {};
      await subscribe(event.callSid, async (_event, delivery) => {
        headers = delivery.headers;
      });

      await fixture.bus.publish(event, { headers: { traceparent: 'abc' } });

      await waitUntil(() => headers.traceparent === 'abc', 'headers');
    });

    it('drops a repeat of the same event id', async () => {
      const event = started();
      let deliveries = 0;
      await subscribe(event.callSid, async () => {
        deliveries += 1;
      });

      await fixture.bus.publish(event);
      await fixture.bus.publish(event);
      await waitUntil(() => deliveries >= 1, 'delivery');
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(deliveries).toBe(1);
    });

    it('retries a failed event and counts the attempts', async () => {
      const event = started();
      const attempts: number[] = [];
      await subscribe(event.callSid, async (_event, delivery) => {
        attempts.push(delivery.attempt);
        if (delivery.attempt < 3) throw new Error('not yet');
      });

      await fixture.bus.publish(event);

      await waitUntil(() => attempts.length === 3, 'retries');
      expect(attempts).toEqual([1, 2, 3]);
    });

    it('moves an event to the dead letters after the last attempt', async () => {
      const event = started();
      let attempts = 0;
      await subscribe(
        event.callSid,
        async () => {
          attempts += 1;
          throw new Error('always fails');
        },
        { maxAttempts: 2 },
      );

      await fixture.bus.publish(event, { headers: { traceparent: 'kept' } });

      const deadLetter = await fixture.waitForDeadLetter('call.started');
      expect(deadLetter.attempts).toBe(2);
      expect(deadLetter.error).toContain('always fails');
      expect(deadLetter.headers.traceparent).toBe('kept');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(attempts).toBe(2);
    });

    it('sends a malformed message straight to the dead letters without retrying', async () => {
      const event = started();
      let handled = 0;
      await subscribe(event.callSid, async () => {
        handled += 1;
      });

      await fixture.publishRaw('helpdesk.message.taken', 'not json at all');

      const deadLetter = await fixture.waitForDeadLetter('message.taken');
      expect(deadLetter.attempts).toBe(1);
      expect(deadLetter.error).toContain('invalid');
      expect(handled).toBe(0);
    });

    it('keeps going after a bad message', async () => {
      const event = started();
      const received: HelpdeskEvent[] = [];
      await subscribe(event.callSid, async (delivered) => {
        received.push(delivered);
      });

      await fixture.publishRaw('helpdesk.call.ended', '{"type":"nonsense"}');
      await fixture.bus.publish(event);

      await waitUntil(() => received.length === 1, 'the good event');
    });
  });
}
