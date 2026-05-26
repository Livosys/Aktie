CREATE TABLE IF NOT EXISTS signal_memory (
  id BIGSERIAL PRIMARY KEY,
  signal_hash TEXT,
  symbol TEXT,
  direction TEXT,
  state TEXT,
  timeframe TEXT,
  features_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  score NUMERIC,
  confidence NUMERIC,
  outcome_type TEXT DEFAULT 'unknown',
  move_after_5m_pct NUMERIC,
  move_after_15m_pct NUMERIC,
  move_after_30m_pct NUMERIC,
  max_favorable_excursion_pct NUMERIC,
  max_adverse_excursion_pct NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  source TEXT DEFAULT 'vector_memory_v1'
);

CREATE INDEX IF NOT EXISTS idx_signal_memory_symbol_created
  ON signal_memory(symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signal_memory_setup
  ON signal_memory(direction, state, timeframe);

CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_memory_hash
  ON signal_memory(signal_hash)
  WHERE signal_hash IS NOT NULL;

-- Optional pgvector support. Run these if the database role may install extensions.
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE signal_memory ADD COLUMN IF NOT EXISTS embedding vector(12);
