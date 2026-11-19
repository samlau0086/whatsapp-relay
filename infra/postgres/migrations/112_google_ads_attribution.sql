CREATE TABLE IF NOT EXISTS google_ads_connection (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  refresh_token_encrypted text,
  revision bigint NOT NULL DEFAULT 0
);
INSERT INTO google_ads_connection(singleton) VALUES(true) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS google_ads_channel_settings (
  account_id uuid PRIMARY KEY REFERENCES livechat_channels(account_id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  customer_id text NOT NULL DEFAULT '',
  login_customer_id text NOT NULL DEFAULT '',
  qualify_lead_action text NOT NULL DEFAULT '',
  close_convert_lead_action text NOT NULL DEFAULT '',
  purchase_action text NOT NULL DEFAULT '',
  revision bigint NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS google_ads_oauth_states (
  state_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verifier_encrypted text NOT NULL,
  connection_revision bigint NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS google_ads_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id uuid UNIQUE REFERENCES livechat_visitors(id) ON DELETE SET NULL,
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  identifiers jsonb NOT NULL DEFAULT '{}'::jsonb,
  captured_at timestamptz,
  locked_at timestamptz NOT NULL DEFAULT now(),
  consent text NOT NULL DEFAULT 'unset' CHECK(consent IN ('unset','granted','denied')),
  consent_revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS google_ads_email_links (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  attribution_id uuid NOT NULL REFERENCES google_ads_attributions(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS google_ads_conversion_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  attribution_id uuid REFERENCES google_ads_attributions(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  client_event_id uuid NOT NULL,
  event_name text NOT NULL CHECK(event_name IN ('qualify_lead','close_convert_lead','purchase')),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  event_params jsonb NOT NULL DEFAULT '{}'::jsonb,
  identifiers jsonb NOT NULL DEFAULT '{}'::jsonb,
  destination jsonb NOT NULL DEFAULT '{}'::jsonb,
  consent text NOT NULL DEFAULT 'unset' CHECK(consent IN ('unset','granted','denied')),
  config_revision bigint,
  connection_revision bigint,
  delivery_state text NOT NULL CHECK(delivery_state IN ('queued','sending','accepted','sent','failed','uncertain','skipped_consent','skipped_config','skipped_attribution')),
  attempts integer NOT NULL DEFAULT 0,
  request_id text,
  last_error text,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,client_event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS google_ads_lead_once ON google_ads_conversion_events(attribution_id,event_name)
  WHERE attribution_id IS NOT NULL AND event_name IN ('qualify_lead','close_convert_lead');
CREATE UNIQUE INDEX IF NOT EXISTS google_ads_purchase_once ON google_ads_conversion_events(order_id)
  WHERE event_name='purchase' AND order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS google_ads_delivery_due ON google_ads_conversion_events(available_at)
  WHERE delivery_state IN ('queued','sending','accepted');
CREATE INDEX IF NOT EXISTS google_ads_conversion_history ON google_ads_conversion_events(conversation_id,created_at DESC);
