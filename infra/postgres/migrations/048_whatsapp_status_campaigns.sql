ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS capabilities text[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS status_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_campaign_id uuid NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
  timezone text NOT NULL,
  start_date date NOT NULL,
  end_date date NOT NULL,
  active_weekdays smallint[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6],
  daily_start time NOT NULL,
  daily_end time NOT NULL,
  interval_minutes integer NOT NULL CHECK(interval_minutes BETWEEN 1 AND 10080),
  audience_filter jsonb NOT NULL DEFAULT '{"mode":"all"}',
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed','cancelled')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  completed_at timestamptz,
  CHECK(end_date>=start_date),
  CHECK(daily_end>daily_start)
);

CREATE TABLE IF NOT EXISTS status_campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES status_campaigns(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  jid text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(campaign_id,jid)
);

CREATE TABLE IF NOT EXISTS status_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_post_id uuid NOT NULL,
  campaign_id uuid NOT NULL REFERENCES status_campaigns(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK(position>=0),
  content_type text NOT NULL CHECK(content_type IN ('text','image','video')),
  text_content text,
  media_id uuid REFERENCES media(id) ON DELETE RESTRICT,
  background_color text,
  font smallint,
  status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','scheduled','dispatching','published','failed','uncertain','expired','cancelled')),
  scheduled_at timestamptz,
  published_at timestamptz,
  expires_at timestamptz,
  whatsapp_message_id text,
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(campaign_id,client_post_id),
  UNIQUE(campaign_id,position),
  CHECK(
    (content_type='text' AND text_content IS NOT NULL AND media_id IS NULL)
    OR (content_type IN ('image','video') AND media_id IS NOT NULL)
  )
);

ALTER TABLE outbound_commands
  ADD COLUMN IF NOT EXISTS status_post_id uuid REFERENCES status_posts(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS status_campaigns_account_idx
  ON status_campaigns(account_id,status,start_date,end_date);
CREATE INDEX IF NOT EXISTS status_posts_due_idx
  ON status_posts(status,scheduled_at,position)
  WHERE status='scheduled';
CREATE INDEX IF NOT EXISTS status_posts_campaign_idx
  ON status_posts(campaign_id,position);
CREATE INDEX IF NOT EXISTS outbound_commands_status_post_idx
  ON outbound_commands(status_post_id)
  WHERE status_post_id IS NOT NULL;
