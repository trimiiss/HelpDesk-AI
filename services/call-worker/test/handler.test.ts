import { MemoryEventBus } from '@helpdesk/broker';
import { createEvent, createLogger, emptyUsage, Registry } from '@helpdesk/shared';
import { describe, expect, it, vi } from 'vitest';
import { createEventHandler, createWorkerMetrics, type HandlerDeps } from '../src/handler.js';
import { formatEmail } from '../src/notifier.js';

const log = createLogger('test', 'silent');
const delivery = { attempt: 1, headers: {} };

function setup(overrides: Partial<HandlerDeps> = {}) {
  const notified = new Set<string>();
  const store = {
    recordStarted: vi.fn(async () => {}),
    recordEnded: vi.fn(async () => {}),
    addTranscript: vi.fn(async () => {}),
    addMessage: vi.fn(async () => {}),
    addTransfer: vi.fn(async () => {}),
    isNotified: vi.fn(async (eventId: string) => notified.has(eventId)),
    markNotified: vi.fn(async (eventId: string) => {
      notified.add(eventId);
    }),
  };
  const notifier = { send: vi.fn(async () => {}) };
  const metrics = createWorkerMetrics(new Registry());
  const handler = createEventHandler({ store, notifier, metrics, log, ...overrides });
  return { handler, store, notifier, metrics };
}

const message = () => createEvent('message.taken', 'CA1', { name: 'Arta', phone: '+383', message: 'Call me' });

describe('routing events', () => {
  it.each([
    ['call.started', createEvent('call.started', 'CA1', { model: 'm' }), 'recordStarted'],
    [
      'call.ended',
      createEvent('call.ended', 'CA1', { reason: 'x', durationMs: 1, usage: emptyUsage(), costUsd: 0 }),
      'recordEnded',
    ],
    [
      'transcript.completed',
      createEvent('transcript.completed', 'CA1', {
        itemId: 'i',
        role: 'agent',
        text: 't',
        sequence: 0,
        interrupted: false,
      }),
      'addTranscript',
    ],
    ['transfer.requested', createEvent('transfer.requested', 'CA1', {}), 'addTransfer'],
  ] as const)('stores %s', async (_type, event, method) => {
    const { handler, store } = setup();
    await handler(event, delivery);
    expect(store[method]).toHaveBeenCalledWith(event);
  });
});

describe('callback messages', () => {
  it('saves the message, then sends the email, then records that', async () => {
    const order: string[] = [];
    const { handler, store, notifier } = setup();
    store.addMessage.mockImplementation(async () => void order.push('saved'));
    notifier.send.mockImplementation(async () => void order.push('emailed'));
    store.markNotified.mockImplementation(async () => void order.push('marked'));

    await handler(message(), delivery);

    expect(order).toEqual(['saved', 'emailed', 'marked']);
  });

  it('does not send a second email when the event is redelivered', async () => {
    const { handler, notifier } = setup();
    const event = message();

    await handler(event, delivery);
    await handler(event, { ...delivery, attempt: 2 });

    expect(notifier.send).toHaveBeenCalledOnce();
  });

  it('keeps the message and retries when the email fails', async () => {
    const { handler, store, notifier } = setup();
    notifier.send.mockRejectedValueOnce(new Error('smtp down'));

    await expect(handler(message(), delivery)).rejects.toThrow('smtp down');

    expect(store.addMessage).toHaveBeenCalledOnce();
    expect(store.markNotified).not.toHaveBeenCalled();
  });

  it('counts sent and failed notifications', async () => {
    const { handler, notifier, metrics } = setup();
    await handler(message(), delivery);
    notifier.send.mockRejectedValueOnce(new Error('smtp down'));
    await handler(message(), delivery).catch(() => {});

    const { values } = await metrics.notifications.get();
    const count = (outcome: string) => values.find((value) => value.labels.outcome === outcome)?.value;
    expect(count('sent')).toBe(1);
    expect(count('failed')).toBe(1);
  });
});

describe('with a real bus', () => {
  it('moves a message to the dead letters when the database stays down', async () => {
    const { handler, store } = setup();
    store.addMessage.mockRejectedValue(new Error('database down'));
    const bus = new MemoryEventBus();
    await bus.subscribe(handler, { durableName: 'w', maxAttempts: 3, backoffMs: [1] });

    await bus.publish(message());
    await vi.waitFor(() => expect(bus.deadLetters).toHaveLength(1));

    expect(bus.deadLetters[0]).toMatchObject({ attempts: 3 });
    expect(bus.deadLetters[0]?.error).toContain('database down');
    await bus.close();
  });

  it('recovers when a failure clears up before the retries run out', async () => {
    const { handler, store } = setup();
    store.addTransfer.mockRejectedValueOnce(new Error('blip'));
    const bus = new MemoryEventBus();
    await bus.subscribe(handler, { durableName: 'w', maxAttempts: 3, backoffMs: [1] });

    await bus.publish(createEvent('transfer.requested', 'CA1', {}));
    await vi.waitFor(() => expect(store.addTransfer).toHaveBeenCalledTimes(2));

    expect(bus.deadLetters).toHaveLength(0);
    await bus.close();
  });
});

describe('email format', () => {
  const email = formatEmail({
    name: 'Arta',
    phone: '+38344000000',
    message: 'Please call me back',
    callSid: 'CA1',
  });

  it('includes everything needed to call back', () => {
    expect(email.text).toContain('Arta');
    expect(email.text).toContain('+38344000000');
    expect(email.text).toContain('Please call me back');
  });

  it('keeps caller text out of the subject, where it could inject headers', () => {
    const hostile = formatEmail({
      name: 'x\r\nBcc: attacker@example.com',
      phone: '1',
      message: 'm',
      callSid: 'CA1',
    });
    expect(hostile.subject).not.toContain('attacker');
    expect(hostile.subject).not.toMatch(/[\r\n]/);
  });
});
