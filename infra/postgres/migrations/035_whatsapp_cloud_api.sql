DO $$ BEGIN
  CREATE TYPE whatsapp_transport AS ENUM ('web','cloud');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE whatsapp_accounts
  ADD COLUMN IF NOT EXISTS transport whatsapp_transport NOT NULL DEFAULT 'web';

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS service_window_expires_at timestamptz;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS failure_code text,
  ADD COLUMN IF NOT EXISTS failure_message text,
  ADD COLUMN IF NOT EXISTS provider_payload jsonb;

ALTER TYPE message_kind ADD VALUE IF NOT EXISTS 'template';

CREATE TABLE IF NOT EXISTS whatsapp_cloud_accounts (
  account_id uuid PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  waba_id text NOT NULL,
  phone_number_id text NOT NULL UNIQUE,
  access_token_encrypted text NOT NULL,
  app_secret_encrypted text NOT NULL,
  verify_token_hash text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  credentials_verified_at timestamptz,
  webhook_verified_at timestamptz,
  last_template_sync_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  language text NOT NULL,
  status text NOT NULL,
  category text,
  components jsonb NOT NULL DEFAULT '[]',
  provider_template_id text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,name,language)
);
CREATE INDEX IF NOT EXISTS whatsapp_message_templates_approved_idx
  ON whatsapp_message_templates(account_id,name,language) WHERE status='APPROVED';

CREATE TABLE IF NOT EXISTS whatsapp_cloud_webhook_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  payload_hash text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS whatsapp_cloud_webhook_events_work_idx
  ON whatsapp_cloud_webhook_events(state,available_at,id);

CREATE INDEX IF NOT EXISTS whatsapp_accounts_transport_idx
  ON whatsapp_accounts(transport,status);
