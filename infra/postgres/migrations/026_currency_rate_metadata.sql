CREATE TABLE IF NOT EXISTS currency_rate_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  source text NOT NULL,
  rate_date date NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
