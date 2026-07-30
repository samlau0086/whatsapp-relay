CREATE TABLE IF NOT EXISTS messenger_oauth_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  app_id text NOT NULL,
  app_secret_encrypted text NOT NULL,
  configuration_id text NOT NULL,
  verify_token_hash text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messenger_oauth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','pages_ready','completed','failed')),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messenger_oauth_page_candidates (
  session_id uuid NOT NULL REFERENCES messenger_oauth_sessions(id) ON DELETE CASCADE,
  page_id text NOT NULL,
  page_name text NOT NULL,
  page_access_token_encrypted text NOT NULL,
  tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,page_id)
);

ALTER TABLE messenger_page_accounts
  ADD COLUMN IF NOT EXISTS auth_source text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS token_refreshed_at timestamptz,
  ADD COLUMN IF NOT EXISTS subscription_status text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS subscription_error text;

DO $$ BEGIN
  ALTER TABLE messenger_page_accounts
    ADD CONSTRAINT messenger_page_accounts_auth_source_check
    CHECK (auth_source IN ('manual','oauth'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE messenger_page_accounts
    ADD CONSTRAINT messenger_page_accounts_subscription_status_check
    CHECK (subscription_status IN ('manual','pending','subscribed','failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS messenger_oauth_sessions_owner_idx
  ON messenger_oauth_sessions(user_id,status,expires_at);
CREATE INDEX IF NOT EXISTS messenger_oauth_sessions_expiry_idx
  ON messenger_oauth_sessions(expires_at);

