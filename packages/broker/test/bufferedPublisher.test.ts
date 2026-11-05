import { createEvent, createLogger, type HelpdeskEvent } from '@helpdesk/shared';
import { describe, expect, it, vi } from 'vitest';
import { BufferedPublisher, type EventBus } from '../src/index.js';

const log = createLogger('test', 'silent');
const event = (reason = 'x') => createEvent('transfer.requested', 'CA1', { reason });

function fakeBus(publish: (event: HelpdeskEvent) => Promise<void>): EventBus {
  return {
    publish,
    subscribe: vi.fn(),
    close: vi.fn(),
  };
}

describe('BufferedPublisher', () => {
  it('returns straight away, without waiting for the broker', () => {
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publisher = new BufferedPublisher({ bus: fakeBus(() => blocked), log });

    const before = performance.now();
    publisher.enqueue(event());

    expect(performance.now() - before).toBeLessThan(5);
    release();
  });

  it('never throws when the broker is down', () => {
    const publisher = new BufferedPublisher({
      bus: fakeBus(() => Promise.reject(new Error('down'))),
      log,
      retryDelayMs: 1,
    });
    expect(() => publisher.enqueue(event())).not.toThrow();
  });

  it('sends events in order', async () => {
    const sent: string[] = [];
    const publisher = new BufferedPublisher({
      bus: fakeBus(async (published) => {
        if (published.type === 'transfer.requested') sent.push(published.reason ?? '');
      }),
      log,
    });

    publisher.enqueue(event('first'));
    publisher.enqueue(event('second'));
    publisher.enqueue(event('third'));
    await publisher.flush(1000);

    expect(sent).toEqual(['first', 'second', 'third']);
  });

  it('keeps retrying, then delivers once the broker recovers', async () => {
    let up = false;
    const sent: HelpdeskEvent[] = [];
    const publisher = new BufferedPublisher({
      bus: fakeBus(async (published) => {
        if (!up) throw new Error('down');
        sent.push(published);
      }),
      log,
      retryDelayMs: 1,
    });

    publisher.enqueue(event());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(0);
    expect(publisher.depth()).toBe(1);

    up = true;
    await publisher.flush(1000);

    expect(sent).toHaveLength(1);
  });

  it('drops the oldest event past the limit, so memory stays bounded', async () => {
    const onDrop = vi.fn();
    const publisher = new BufferedPublisher({
      bus: fakeBus(() => Promise.reject(new Error('down'))),
      log,
      maxQueueSize: 2,
      retryDelayMs: 1000,
      onDrop,
    });

    publisher.enqueue(event('a'));
    publisher.enqueue(event('b'));
    publisher.enqueue(event('c'));

    expect(publisher.depth()).toBe(2);
    expect(onDrop).toHaveBeenCalledOnce();
  });

  it('publishNow reports failure so a caller is never told a lie', async () => {
    const publisher = new BufferedPublisher({
      bus: fakeBus(() => Promise.reject(new Error('down'))),
      log,
    });
    await expect(publisher.publishNow(event(), {}, 100)).rejects.toThrow('down');
  });

  it('flush gives up at the deadline instead of hanging shutdown', async () => {
    const publisher = new BufferedPublisher({
      bus: fakeBus(() => Promise.reject(new Error('down'))),
      log,
      retryDelayMs: 1,
    });
    publisher.enqueue(event());

    const before = Date.now();
    await publisher.flush(50);

    expect(Date.now() - before).toBeLessThan(500);
  });
});
