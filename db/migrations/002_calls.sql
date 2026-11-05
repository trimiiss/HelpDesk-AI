-- Events can arrive in any order, so everything except call_sid is nullable.
CREATE TABLE calls (
  call_sid TEXT PRIMARY KEY,
  from_number TEXT,
  to_number TEXT,
  model TEXT,
  trace_id TEXT,
  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  end_reason TEXT,
  duration_ms BIGINT,
  usage JSONB,
  cost_usd NUMERIC(12, 6),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calls_recent_idx ON calls (COALESCE(started_at, first_seen_at) DESC);

-- Each of these tables uses event_id as its key, so a redelivered event is a no-op.
CREATE TABLE transcript_turns (
  event_id UUID PRIMARY KEY,
  call_sid TEXT NOT NULL REFERENCES calls (call_sid) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('caller', 'agent')),
  text TEXT NOT NULL,
  sequence INT NOT NULL,
  interrupted BOOLEAN NOT NULL DEFAULT FALSE,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX transcript_turns_call_idx ON transcript_turns (call_sid, sequence);

CREATE TABLE messages (
  event_id UUID PRIMARY KEY,
  call_sid TEXT NOT NULL REFERENCES calls (call_sid) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  message TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  -- Set once the email has gone, so a retry doesn't send it twice.
  notified_at TIMESTAMPTZ
);

CREATE INDEX messages_recent_idx ON messages (occurred_at DESC);
CREATE INDEX messages_call_idx ON messages (call_sid);

CREATE TABLE transfers (
  event_id UUID PRIMARY KEY,
  call_sid TEXT NOT NULL REFERENCES calls (call_sid) ON DELETE CASCADE,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX transfers_call_idx ON transfers (call_sid);
