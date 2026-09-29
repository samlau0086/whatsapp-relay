DO $$ BEGIN
  IF to_regclass('public.proactive_outreach_settings') IS NULL THEN RETURN; END IF;
  ALTER TABLE proactive_outreach_settings ADD COLUMN IF NOT EXISTS email_enabled boolean NOT NULL DEFAULT false;
  ALTER TABLE proactive_outreach_settings ADD COLUMN IF NOT EXISTS email_templates jsonb NOT NULL DEFAULT '[]'::jsonb;
  ALTER TABLE contacts ADD COLUMN IF NOT EXISTS proactive_email_allowed boolean NOT NULL DEFAULT false;
  ALTER TABLE proactive_outreach_jobs DROP CONSTRAINT IF EXISTS proactive_outreach_jobs_state_check;
  ALTER TABLE proactive_outreach_jobs ADD CONSTRAINT proactive_outreach_jobs_state_check CHECK(state IN ('pending','processing','awaiting_approval','queued','sent','skipped','cancelled','failed'));
END $$;
