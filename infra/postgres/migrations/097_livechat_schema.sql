ALTER TYPE channel_platform ADD VALUE IF NOT EXISTS 'livechat';

CREATE TABLE IF NOT EXISTS livechat_channels (
  account_id uuid PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  welcome_message text NOT NULL DEFAULT '',
  theme_color text NOT NULL DEFAULT '#2563eb',
  position text NOT NULL DEFAULT 'right' CHECK (position IN ('left', 'right')),
  allowed_origins text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (theme_color ~ '^#[0-9A-Fa-f]{6}$'),
  CHECK (archived_at IS NULL OR NOT enabled)
);

CREATE TABLE IF NOT EXISTS livechat_visitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES livechat_channels(account_id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  credential_hash text NOT NULL UNIQUE,
  embed_origin text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, contact_id)
);

CREATE INDEX IF NOT EXISTS livechat_visitors_account_idx ON livechat_visitors(account_id);

ALTER TABLE livechat_visitors ADD COLUMN IF NOT EXISTS embed_origin text NOT NULL DEFAULT '';
ALTER TABLE livechat_visitors ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT now() + interval '180 days';

CREATE TABLE IF NOT EXISTS livechat_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  PRIMARY KEY(bucket,window_start)
);
CREATE INDEX IF NOT EXISTS livechat_rate_limits_expiry_idx ON livechat_rate_limits(window_start);
