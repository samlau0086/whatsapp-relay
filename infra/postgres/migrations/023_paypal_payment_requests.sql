CREATE TABLE IF NOT EXISTS paypal_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  enabled boolean NOT NULL DEFAULT false,
  environment text NOT NULL DEFAULT 'sandbox' CHECK(environment IN ('sandbox','live')),
  client_id_encrypted text,
  client_secret_encrypted text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO paypal_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS order_payment_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'paypal' CHECK(provider='paypal'),
  environment text NOT NULL CHECK(environment IN ('sandbox','live')),
  provider_request_id text,
  payment_url text,
  status text NOT NULL DEFAULT 'CREATING',
  amount numeric(12,2) NOT NULL CHECK(amount>0),
  currency text NOT NULL,
  is_current boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  cancelled_at timestamptz,
  failure_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS order_payment_requests_current_unique ON order_payment_requests(order_id) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS order_payment_requests_provider_id_unique ON order_payment_requests(environment,provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS order_payment_requests_order_created_idx ON order_payment_requests(order_id,created_at DESC);
