ALTER TABLE livechat_channels
  ADD COLUMN IF NOT EXISTS ga4_measurement_id text,
  ADD COLUMN IF NOT EXISTS ga4_api_secret_encrypted text;

ALTER TABLE livechat_channels
  DROP CONSTRAINT IF EXISTS livechat_channels_ga4_measurement_id_check;
ALTER TABLE livechat_channels
  ADD CONSTRAINT livechat_channels_ga4_measurement_id_check
  CHECK (ga4_measurement_id IS NULL OR ga4_measurement_id ~ '^G-[A-Z0-9]+$');

ALTER TABLE livechat_visitors
  ADD COLUMN IF NOT EXISTS analytics_consent text NOT NULL DEFAULT 'unset',
  ADD COLUMN IF NOT EXISTS analytics_client_id text,
  ADD COLUMN IF NOT EXISTS analytics_measurement_id text,
  ADD COLUMN IF NOT EXISTS analytics_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lead_message_id uuid;
ALTER TABLE livechat_visitors
  DROP CONSTRAINT IF EXISTS livechat_visitors_analytics_consent_check;
ALTER TABLE livechat_visitors
  ADD CONSTRAINT livechat_visitors_analytics_consent_check
  CHECK (analytics_consent IN ('granted','denied','unset'));
ALTER TABLE livechat_visitors
  DROP CONSTRAINT IF EXISTS livechat_visitors_analytics_client_id_check;
ALTER TABLE livechat_visitors
  ADD CONSTRAINT livechat_visitors_analytics_client_id_check
  CHECK (analytics_client_id IS NULL OR analytics_client_id ~ '^[0-9]{1,20}\.[0-9]{1,20}$');

CREATE TABLE IF NOT EXISTS livechat_conversion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES livechat_channels(account_id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_event_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('automatic','agent')),
  event_name text NOT NULL CHECK (event_name ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  event_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  analytics_consent text NOT NULL DEFAULT 'unset' CHECK (analytics_consent IN ('granted','denied','unset')),
  ga4_client_id text,
  delivery_state text NOT NULL DEFAULT 'skipped_consent' CHECK (delivery_state IN ('browser_managed','queued','sending','sent','uncertain','skipped_consent','skipped_config','skipped_client_id','failed')),
  ga4_measurement_id text,
  ga4_config_fingerprint text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ga4_client_id IS NULL OR ga4_client_id ~ '^[0-9]{1,20}\.[0-9]{1,20}$'),
  UNIQUE (account_id, client_event_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS livechat_conversion_purchase_order_unique
  ON livechat_conversion_events(order_id)
  WHERE event_name = 'purchase' AND order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS livechat_conversion_conversation_created_idx
  ON livechat_conversion_events(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS livechat_conversion_delivery_idx
  ON livechat_conversion_events(available_at, created_at)
  WHERE delivery_state IN ('queued','sending');
