import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPool, migrate, type Pool } from '@helpdesk/db';
import { createEvent, createLogger, emptyUsage } from '@helpdesk/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CallStore } from '../src/store.js';

/** Runs against a real database. `npm run test:integration` sets this up. */
const url = process.env.TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../db/migrations', import.meta.url));

describe.runIf(url)('CallStore with Postgres', () => {
  let pool: Pool;
  let store: CallStore;

  const callSid = () => `CA${randomUUID()}`;

  const row = async (sid: string) => {
    const { rows } = await pool.query<Record<string, unknown>>('SELECT * FROM calls WHERE call_sid = $1', [sid]);
    return rows[0];
  };

  const ended = (sid: string) =>
    createEvent('call.ended', sid, {
      reason: 'caller_hangup',
      durationMs: 5000,
      usage: { ...emptyUsage(), audioOutputTokens: 42 },
      costUsd: 0.0123,
    });

  beforeAll(async () => {
    pool = createPool(url ?? '');
    await migrate(pool, migrations, createLogger('test', 'silent'));
    store = new CallStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('records a call from start to end', async () => {
    const sid = callSid();
    await store.recordStarted(
      createEvent('call.started', sid, { model: 'm', from: '+1', to: '+2', traceId: 'abc' }),
    );
    await store.recordEnded(ended(sid));

    expect(await row(sid)).toMatchObject({
      from_number: '+1',
      to_number: '+2',
      model: 'm',
      trace_id: 'abc',
      end_reason: 'caller_hangup',
      cost_usd: '0.012300',
    });
  });

  it('copes with call.ended arriving before call.started', async () => {
    const sid = callSid();
    await store.recordEnded(ended(sid));
    await store.recordStarted(createEvent('call.started', sid, { model: 'm', from: '+1' }));

    expect(await row(sid)).toMatchObject({ from_number: '+1', end_reason: 'caller_hangup' });
  });

  it('copes with a transcript arriving before the call has started', async () => {
    const sid = callSid();
    await store.addTranscript(
      createEvent('transcript.completed', sid, {
        itemId: 'i',
        role: 'caller',
        text: 'hello',
        sequence: 1,
        interrupted: false,
      }),
    );
    expect(await row(sid)).toBeDefined();
  });

  it('stores a redelivered transcript only once', async () => {
    const sid = callSid();
    const event = createEvent('transcript.completed', sid, {
      itemId: 'i',
      role: 'agent',
      text: 'hi',
      sequence: 1,
      interrupted: true,
    });

    await store.addTranscript(event);
    await store.addTranscript(event);

    const { rows } = await pool.query('SELECT interrupted FROM transcript_turns WHERE call_sid = $1', [sid]);
    expect(rows).toEqual([{ interrupted: true }]);
  });

  it('returns transcript turns in conversation order, not arrival order', async () => {
    const sid = callSid();
    for (const sequence of [3, 1, 2]) {
      await store.addTranscript(
        createEvent('transcript.completed', sid, {
          itemId: `i${sequence}`,
          role: 'caller',
          text: `turn ${sequence}`,
          sequence,
          interrupted: false,
        }),
      );
    }
    const { rows } = await pool.query<{ text: string }>(
      'SELECT text FROM transcript_turns WHERE call_sid = $1 ORDER BY sequence',
      [sid],
    );
    expect(rows.map((turn) => turn.text)).toEqual(['turn 1', 'turn 2', 'turn 3']);
  });

  it('tracks whether a message has been notified', async () => {
    const sid = callSid();
    const event = createEvent('message.taken', sid, { name: 'A', phone: '+1', message: 'm' });

    await store.addMessage(event);
    await store.addMessage(event);
    expect(await store.isNotified(event.eventId)).toBe(false);

    await store.markNotified(event.eventId);
    expect(await store.isNotified(event.eventId)).toBe(true);
  });

  it('stores a redelivered transfer only once', async () => {
    const sid = callSid();
    const event = createEvent('transfer.requested', sid, { reason: 'asked for a person' });

    await store.addTransfer(event);
    await store.addTransfer(event);

    const { rows } = await pool.query('SELECT reason FROM transfers WHERE call_sid = $1', [sid]);
    expect(rows).toEqual([{ reason: 'asked for a person' }]);
  });
});
