-- Account-level, low-frequency proactive outreach for qualified cold contacts.
CREATE TABLE IF NOT EXISTS proactive_outreach_settings (
  account_id uuid PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  max_touches_per_year smallint NOT NULL DEFAULT 5 CHECK(max_touches_per_year BETWEEN 1 AND 12),
  local_send_start time NOT NULL DEFAULT '10:00',
  local_send_end time NOT NULL DEFAULT '17:00',
  country_holidays jsonb NOT NULL DEFAULT '{}'::jsonb,
  cloud_templates jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS country_code text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS proactive_suppressed_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS proactive_suppression_reason text;
UPDATE contacts SET country_code=upper(NULLIF(btrim(country_code),'')) WHERE country_code IS NOT NULL;
ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_country_code_check;
ALTER TABLE contacts ADD CONSTRAINT contacts_country_code_check CHECK(country_code IS NULL OR country_code ~ '^[A-Z]{2}$');

CREATE TABLE IF NOT EXISTS proactive_outreach_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  trigger_kind text NOT NULL CHECK(trigger_kind IN ('cold','holiday')), trigger_key text, planned_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','sent','skipped','cancelled','failed')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, message_id uuid REFERENCES messages(id) ON DELETE SET NULL, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS proactive_outreach_pending_unique ON proactive_outreach_jobs(contact_id) WHERE state IN ('pending','processing');
CREATE INDEX IF NOT EXISTS proactive_outreach_jobs_ready_idx ON proactive_outreach_jobs(state,planned_at) WHERE state IN ('pending','processing');
CREATE TABLE IF NOT EXISTS proactive_outreach_events (
  id bigserial PRIMARY KEY, account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE, job_id uuid REFERENCES proactive_outreach_jobs(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK(event_type IN ('planned','sent','skipped','cancelled','suppressed','restored','failed')),
  reason text, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proactive_outreach_events_contact_idx ON proactive_outreach_events(contact_id,created_at DESC);
