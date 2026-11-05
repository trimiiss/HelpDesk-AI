import type { HelpdeskEvent } from '@helpdesk/shared';
import type { Pool } from 'pg';

type EventOf<T extends HelpdeskEvent['type']> = Extract<HelpdeskEvent, { type: T }>;

/**
 * Every write here is safe to repeat, because JetStream delivers at least once.
 * Events can also arrive in any order, so each one creates its call row if needed
 * and COALESCE stops a later event from blanking what an earlier one recorded.
 */
export class CallStore {
  constructor(private readonly pool: Pool) {}

  async recordStarted(event: EventOf<'call.started'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO calls (call_sid, from_number, to_number, model, trace_id, started_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (call_sid) DO UPDATE SET
         from_number = COALESCE(EXCLUDED.from_number, calls.from_number),
         to_number = COALESCE(EXCLUDED.to_number, calls.to_number),
         model = COALESCE(EXCLUDED.model, calls.model),
         trace_id = COALESCE(EXCLUDED.trace_id, calls.trace_id),
         started_at = COALESCE(EXCLUDED.started_at, calls.started_at)`,
      [event.callSid, event.from, event.to, event.model, event.traceId, event.occurredAt],
    );
  }

  async recordEnded(event: EventOf<'call.ended'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO calls (call_sid, ended_at, end_reason, duration_ms, usage, cost_usd, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (call_sid) DO UPDATE SET
         ended_at = EXCLUDED.ended_at,
         end_reason = EXCLUDED.end_reason,
         duration_ms = EXCLUDED.duration_ms,
         usage = EXCLUDED.usage,
         cost_usd = EXCLUDED.cost_usd,
         trace_id = COALESCE(calls.trace_id, EXCLUDED.trace_id)`,
      [
        event.callSid,
        event.occurredAt,
        event.reason,
        event.durationMs,
        JSON.stringify(event.usage),
        event.costUsd,
        event.traceId,
      ],
    );
  }

  async addTranscript(event: EventOf<'transcript.completed'>): Promise<void> {
    await this.ensureCall(event.callSid);
    await this.pool.query(
      `INSERT INTO transcript_turns
         (event_id, call_sid, item_id, role, text, sequence, interrupted, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.eventId,
        event.callSid,
        event.itemId,
        event.role,
        event.text,
        event.sequence,
        event.interrupted,
        event.occurredAt,
      ],
    );
  }

  async addMessage(event: EventOf<'message.taken'>): Promise<void> {
    await this.ensureCall(event.callSid);
    await this.pool.query(
      `INSERT INTO messages (event_id, call_sid, name, phone, message, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.callSid, event.name, event.phone, event.message, event.occurredAt],
    );
  }

  async addTransfer(event: EventOf<'transfer.requested'>): Promise<void> {
    await this.ensureCall(event.callSid);
    await this.pool.query(
      `INSERT INTO transfers (event_id, call_sid, reason, occurred_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.callSid, event.reason, event.occurredAt],
    );
  }

  async isNotified(eventId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ notified_at: Date | null }>(
      'SELECT notified_at FROM messages WHERE event_id = $1',
      [eventId],
    );
    return rows[0]?.notified_at != null;
  }

  async markNotified(eventId: string): Promise<void> {
    await this.pool.query('UPDATE messages SET notified_at = now() WHERE event_id = $1', [eventId]);
  }

  private async ensureCall(callSid: string): Promise<void> {
    await this.pool.query('INSERT INTO calls (call_sid) VALUES ($1) ON CONFLICT DO NOTHING', [
      callSid,
    ]);
  }
}
