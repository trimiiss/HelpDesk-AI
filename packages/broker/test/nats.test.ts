import { randomUUID } from 'node:crypto';
import { AckPolicy, DeliverPolicy, jetstream, jetstreamManager } from '@nats-io/jetstream';
import { connect } from '@nats-io/transport-node';
import { createLogger } from '@helpdesk/shared';
import { describe, expect, it } from 'vitest';
import { NatsEventBus } from '../src/index.js';
import { eventBusContract, type BusFixture } from './contract.js';

/** Runs against a real server. Set TEST_NATS_URL, or `npm run test:integration` does it for you. */
const url = process.env.TEST_NATS_URL;
const log = createLogger('test', 'silent');

async function createFixture(): Promise<BusFixture> {
  const bus = new NatsEventBus({ url: url ?? '', log });
  const connection = await connect({ servers: url ?? '' });
  const manager = await jetstreamManager(connection);
  const client = jetstream(connection);

  // Other tests share the server, so this test only reads dead letters from now on.
  await bus.subscribe(async () => {}, {
    durableName: `warmup-${randomUUID()}`,
    maxAttempts: 1,
    backoffMs: [0],
  }).then((subscription) => subscription.stop());

  const consumerName = `dlq-${randomUUID()}`;
  await manager.consumers.add('HELPDESK_DLQ', {
    durable_name: consumerName,
    ack_policy: AckPolicy.Explicit,
    deliver_policy: DeliverPolicy.New,
  });
  const consumer = await client.consumers.get('HELPDESK_DLQ', consumerName);

  return {
    bus,
    publishRaw: (subject, payload) => bus.publishRaw(subject, payload),
    async waitForDeadLetter(match) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const message = await consumer.next({ expires: 1000 });
        if (message?.subject.includes(match)) {
          message.ack();
          const headers: Record<string, string> = {};
          for (const key of message.headers?.keys() ?? []) {
            headers[key] = message.headers?.get(key) ?? '';
          }
          return {
            error: headers['x-helpdesk-error'] ?? '',
            attempts: Number(headers['x-helpdesk-attempts']),
            headers,
          };
        }
        message?.ack();
      }
      throw new Error('no dead letter arrived');
    },
    async cleanup() {
      await manager.consumers.delete('HELPDESK_DLQ', consumerName);
      await connection.drain();
      await bus.close();
    },
  };
}

if (url) {
  eventBusContract('NATS JetStream', createFixture);
}

describe.runIf(url)('NATS specifics', () => {
  it('reports publish failure when the server is unreachable', async () => {
    const bus = new NatsEventBus({ url: 'nats://127.0.0.1:1', log });
    const { createEvent } = await import('@helpdesk/shared');

    await expect(
      bus.publish(createEvent('transfer.requested', 'CA1', {}), { timeoutMs: 200 }),
    ).rejects.toThrow('not connected');
  });

  it('does not block construction while the server is down', () => {
    const before = Date.now();
    new NatsEventBus({ url: 'nats://127.0.0.1:1', log });
    expect(Date.now() - before).toBeLessThan(100);
  });
});
