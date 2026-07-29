DO $$ BEGIN
  CREATE TYPE channel_platform AS ENUM ('whatsapp','messenger');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  IF to_regclass('public.channel_accounts') IS NULL
     AND to_regclass('public.whatsapp_accounts') IS NOT NULL THEN
    ALTER TABLE whatsapp_accounts RENAME TO channel_accounts;
  END IF;
END $$;
ALTER TABLE channel_accounts
  ADD COLUMN IF NOT EXISTS platform channel_platform NOT NULL DEFAULT 'whatsapp';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='channel_accounts' AND column_name='wa_jid')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='channel_accounts' AND column_name='provider_user_id') THEN
    ALTER TABLE channel_accounts RENAME COLUMN wa_jid TO provider_user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contacts' AND column_name='wa_jid')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='contacts' AND column_name='provider_user_id') THEN
    ALTER TABLE contacts RENAME COLUMN wa_jid TO provider_user_id;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='whatsapp_message_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='messages' AND column_name='provider_message_id') THEN
    ALTER TABLE messages RENAME COLUMN whatsapp_message_id TO provider_message_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION prevent_channel_platform_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.platform IS DISTINCT FROM OLD.platform THEN
    RAISE EXCEPTION 'channel account platform is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS channel_accounts_platform_immutable ON channel_accounts;
CREATE TRIGGER channel_accounts_platform_immutable
BEFORE UPDATE OF platform ON channel_accounts
FOR EACH ROW EXECUTE FUNCTION prevent_channel_platform_change();

CREATE TABLE IF NOT EXISTS messenger_page_accounts (
  account_id uuid PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,
  page_id text NOT NULL UNIQUE,
  page_access_token_encrypted text NOT NULL,
  app_secret_encrypted text NOT NULL,
  verify_token_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  credentials_verified_at timestamptz,
  webhook_verified_at timestamptz,
  last_webhook_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messenger_webhook_events (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  page_id text NOT NULL,
  payload_hash text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  attempt integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(account_id,payload_hash)
);

CREATE INDEX IF NOT EXISTS channel_accounts_platform_transport_idx
  ON channel_accounts(platform,transport,status);
CREATE INDEX IF NOT EXISTS messenger_page_accounts_enabled_idx
  ON messenger_page_accounts(enabled,page_id);
CREATE INDEX IF NOT EXISTS messenger_webhook_events_work_idx
  ON messenger_webhook_events(state,available_at,id);

ALTER TABLE contacts ALTER COLUMN phone_e164 DROP NOT NULL;

COMMENT ON COLUMN contacts.provider_user_id IS
  'WhatsApp JID or Messenger Page-scoped user ID';
COMMENT ON COLUMN channel_accounts.provider_user_id IS
  'Provider-side account identifier when the platform exposes one';
COMMENT ON COLUMN messages.provider_message_id IS
  'Provider message identifier, scoped by channel account';
