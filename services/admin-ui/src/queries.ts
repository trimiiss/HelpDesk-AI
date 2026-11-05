import type { Pool } from 'pg';

export interface CallSummary {
  callSid: string;
  from: string | null;
  startedAt: Date | null;
  durationMs: number | null;
  endReason: string | null;
  costUsd: number | null;
  turns: number;
  messages: number;
}

export interface Turn {
  role: 'caller' | 'agent';
  text: string;
  interrupted: boolean;
}

export interface CallbackMessage {
  callSid: string;
  name: string;
  phone: string;
  message: string;
  occurredAt: Date;
  notifiedAt: Date | null;
}

export interface CallDetail extends CallSummary {
  to: string | null;
  model: string | null;
  traceId: string | null;
  transcript: Turn[];
  callMessages: CallbackMessage[];
  transfers: { reason: string | null; occurredAt: Date }[];
}

export interface Totals {
  calls: number;
  messages: number;
  costUsd: number;
}

interface CallRow {
  call_sid: string;
  from_number: string | null;
  to_number: string | null;
  model: string | null;
  trace_id: string | null;
  started_at: Date | null;
  duration_ms: string | null;
  end_reason: string | null;
  cost_usd: string | null;
  turns: string;
  messages: string;
}

const toSummary = (row: CallRow): CallSummary => ({
  callSid: row.call_sid,
  from: row.from_number,
  startedAt: row.started_at,
  durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  endReason: row.end_reason,
  costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
  turns: Number(row.turns),
  messages: Number(row.messages),
});

const CALL_COLUMNS = `
  c.call_sid, c.from_number, c.to_number, c.model, c.trace_id, c.started_at,
  c.duration_ms, c.end_reason, c.cost_usd,
  (SELECT count(*) FROM transcript_turns t WHERE t.call_sid = c.call_sid) AS turns,
  (SELECT count(*) FROM messages m WHERE m.call_sid = c.call_sid) AS messages
`;

export const PAGE_SIZE = 50;

export class AdminQueries {
  constructor(private readonly pool: Pool) {}

  async totals(): Promise<Totals> {
    const { rows } = await this.pool.query<{ calls: string; messages: string; cost: string }>(`
      SELECT
        (SELECT count(*) FROM calls) AS calls,
        (SELECT count(*) FROM messages) AS messages,
        (SELECT COALESCE(sum(cost_usd), 0) FROM calls) AS cost
    `);
    const row = rows[0];
    return {
      calls: Number(row?.calls ?? 0),
      messages: Number(row?.messages ?? 0),
      costUsd: Number(row?.cost ?? 0),
    };
  }

  async listCalls(page: number): Promise<CallSummary[]> {
    const { rows } = await this.pool.query<CallRow>(
      `SELECT ${CALL_COLUMNS}
       FROM calls c
       ORDER BY COALESCE(c.started_at, c.first_seen_at) DESC
       LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, (page - 1) * PAGE_SIZE],
    );
    return rows.map(toSummary);
  }

  async getCall(callSid: string): Promise<CallDetail | undefined> {
    const { rows } = await this.pool.query<CallRow>(
      `SELECT ${CALL_COLUMNS} FROM calls c WHERE c.call_sid = $1`,
      [callSid],
    );
    const row = rows[0];
    if (!row) return undefined;

    const [transcript, messages, transfers] = await Promise.all([
      this.pool.query<{ role: Turn['role']; text: string; interrupted: boolean }>(
        `SELECT role, text, interrupted FROM transcript_turns
         WHERE call_sid = $1 ORDER BY sequence, occurred_at`,
        [callSid],
      ),
      this.listMessagesFor(callSid),
      this.pool.query<{ reason: string | null; occurred_at: Date }>(
        'SELECT reason, occurred_at FROM transfers WHERE call_sid = $1 ORDER BY occurred_at',
        [callSid],
      ),
    ]);

    return {
      ...toSummary(row),
      to: row.to_number,
      model: row.model,
      traceId: row.trace_id,
      transcript: transcript.rows,
      callMessages: messages,
      transfers: transfers.rows.map(({ reason, occurred_at }) => ({
        reason,
        occurredAt: occurred_at,
      })),
    };
  }

  async listMessages(page: number): Promise<CallbackMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT call_sid, name, phone, message, occurred_at, notified_at
       FROM messages ORDER BY occurred_at DESC LIMIT $1 OFFSET $2`,
      [PAGE_SIZE, (page - 1) * PAGE_SIZE],
    );
    return rows.map(toMessage);
  }

  private async listMessagesFor(callSid: string): Promise<CallbackMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT call_sid, name, phone, message, occurred_at, notified_at
       FROM messages WHERE call_sid = $1 ORDER BY occurred_at`,
      [callSid],
    );
    return rows.map(toMessage);
  }
}

interface MessageRow {
  call_sid: string;
  name: string;
  phone: string;
  message: string;
  occurred_at: Date;
  notified_at: Date | null;
}

const toMessage = (row: MessageRow): CallbackMessage => ({
  callSid: row.call_sid,
  name: row.name,
  phone: row.phone,
  message: row.message,
  occurredAt: row.occurred_at,
  notifiedAt: row.notified_at,
});
