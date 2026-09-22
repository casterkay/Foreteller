export const migrations: readonly string[] = [
  `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE session_status_events (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      status TEXT NOT NULL CHECK (status IN ('draft', 'waiting', 'live', 'halted', 'ended')),
      occurred_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE bindings (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      event_id TEXT NOT NULL,
      rules_hash TEXT NOT NULL,
      binding_json TEXT NOT NULL,
      confirmed_at_ms INTEGER NOT NULL,
      UNIQUE (session_id, rules_hash, confirmed_at_ms)
    ) STRICT;

    CREATE TABLE transcript_segments (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      segment_id TEXT NOT NULL,
      segment_json TEXT NOT NULL,
      source_start_ms INTEGER NOT NULL,
      source_end_ms INTEGER NOT NULL,
      received_at_ms INTEGER NOT NULL,
      is_final INTEGER NOT NULL CHECK (is_final IN (0, 1)),
      PRIMARY KEY (session_id, segment_id)
    ) STRICT;

    CREATE TABLE book_snapshots (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      market_id TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE forecasts (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      market_id TEXT NOT NULL,
      forecast_json TEXT NOT NULL,
      snapshot_at_ms INTEGER NOT NULL,
      recorded_at_ms INTEGER NOT NULL,
      UNIQUE (session_id, market_id, snapshot_at_ms)
    ) STRICT;

    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      event_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      strategy TEXT NOT NULL CHECK (strategy IN ('sniper', 'forecast')),
      accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
      reason TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE order_intents (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      event_id TEXT NOT NULL,
      market_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      strategy TEXT NOT NULL CHECK (strategy IN ('sniper', 'forecast')),
      notional_micros INTEGER NOT NULL CHECK (notional_micros > 0),
      fee_reserve_micros INTEGER NOT NULL CHECK (fee_reserve_micros >= 0),
      max_price REAL NOT NULL CHECK (max_price > 0 AND max_price <= 1),
      evidence_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      utc_day TEXT NOT NULL
    ) STRICT;

    CREATE TABLE order_events (
      id INTEGER PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES order_intents(id),
      status TEXT NOT NULL CHECK (status IN (
        'reserved', 'submitted', 'unknown', 'partially_filled',
        'filled', 'cancelled', 'failed'
      )),
      venue_order_id TEXT,
      reason TEXT,
      occurred_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE fills (
      id INTEGER PRIMARY KEY,
      venue_trade_id TEXT NOT NULL,
      venue_order_id TEXT NOT NULL,
      intent_id TEXT NOT NULL REFERENCES order_intents(id),
      price REAL NOT NULL CHECK (price > 0 AND price <= 1),
      shares REAL NOT NULL CHECK (shares > 0),
      fee_micros INTEGER NOT NULL CHECK (fee_micros >= 0),
      notional_micros INTEGER NOT NULL CHECK (notional_micros > 0),
      status TEXT NOT NULL CHECK (status IN ('matched', 'confirmed', 'failed')),
      occurred_at_ms INTEGER NOT NULL,
      ingested_at_ms INTEGER NOT NULL,
      UNIQUE (venue_trade_id, status)
    ) STRICT;

    CREATE TABLE outcomes (
      id INTEGER PRIMARY KEY,
      market_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no', 'void', 'unresolved')),
      observed_at_ms INTEGER NOT NULL,
      UNIQUE (market_id, outcome, observed_at_ms)
    ) STRICT;

    CREATE INDEX order_intents_day_idx ON order_intents(utc_day);
    CREATE INDEX order_intents_event_idx ON order_intents(event_id);
    CREATE INDEX order_intents_market_strategy_idx
      ON order_intents(market_id, strategy);
    CREATE INDEX order_events_intent_idx ON order_events(intent_id, id);
    CREATE INDEX fills_intent_idx ON fills(intent_id, id);
  `,
];
