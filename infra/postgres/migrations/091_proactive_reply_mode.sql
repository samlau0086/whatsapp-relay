-- Per-conversation handling for the first customer response to a full-mode outreach.
ALTER TABLE conversation_agent_state
  ADD COLUMN IF NOT EXISTS proactive_reply_mode text NOT NULL DEFAULT 'cautious';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversation_agent_state_proactive_reply_mode_check'
      AND conrelid = 'conversation_agent_state'::regclass
  ) THEN
    ALTER TABLE conversation_agent_state
      ADD CONSTRAINT conversation_agent_state_proactive_reply_mode_check
      CHECK (proactive_reply_mode IN ('cautious', 'full', 'human_paused'));
  END IF;
END $$;

ALTER TABLE proactive_outreach_jobs
  ADD COLUMN IF NOT EXISTS sent_agent_mode text,
  ADD COLUMN IF NOT EXISTS sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS reply_processed_at timestamptz;

CREATE INDEX IF NOT EXISTS proactive_outreach_unanswered_full_idx
  ON proactive_outreach_jobs(conversation_id, completed_at DESC)
  WHERE state='sent' AND sent_agent_mode='full' AND reply_processed_at IS NULL;
