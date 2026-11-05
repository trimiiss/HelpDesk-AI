import { describe, expect, it } from 'vitest';
import { createEvent, emptyUsage, eventSchema, subjectFor } from '../src/events.js';

describe('events', () => {
  it('creates events that pass their own schema', () => {
    const events = [
      createEvent('call.started', 'CA1', { model: 'm', from: '+1', to: '+2' }),
      createEvent('call.ended', 'CA1', {
        reason: 'caller_hangup',
        durationMs: 10,
        usage: emptyUsage(),
        costUsd: 0.1,
      }),
      createEvent('transcript.completed', 'CA1', {
        itemId: 'item_1',
        role: 'caller',
        text: 'hello',
        sequence: 1,
        interrupted: false,
      }),
      createEvent('message.taken', 'CA1', { name: 'A', phone: '+1', message: 'hi' }),
      createEvent('transfer.requested', 'CA1', {}),
    ];
    for (const event of events) expect(eventSchema.safeParse(event).success).toBe(true);
  });

  it('gives every event its own id so duplicates can be spotted', () => {
    const first = createEvent('transfer.requested', 'CA1', {});
    const second = createEvent('transfer.requested', 'CA1', {});
    expect(first.eventId).not.toBe(second.eventId);
  });

  it('rejects an unknown event type', () => {
    expect(eventSchema.safeParse({ type: 'call.exploded', callSid: 'CA1' }).success).toBe(false);
  });

  it('rejects a message with missing fields', () => {
    const event = { ...createEvent('message.taken', 'CA1', { name: 'A', phone: '+1', message: 'x' }) };
    expect(eventSchema.safeParse({ ...event, message: '' }).success).toBe(false);
  });

  it('maps each type to a subject under the stream prefix', () => {
    expect(subjectFor('call.started')).toBe('helpdesk.call.started');
    expect(subjectFor('message.taken')).toBe('helpdesk.message.taken');
  });
});
