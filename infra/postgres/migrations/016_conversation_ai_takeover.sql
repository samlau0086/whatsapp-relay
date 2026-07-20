-- Account settings make AI available; takeover remains opt-in per conversation.
ALTER TABLE conversation_agent_state
  ALTER COLUMN mode SET DEFAULT 'human_paused';

CREATE TABLE IF NOT EXISTS relay_schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Old inbound messages created active rows implicitly. Reset them once, then
-- preserve future conversation-level choices across API restarts.
DO $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('016_conversation_ai_takeover'));
  IF NOT EXISTS (
    SELECT 1 FROM relay_schema_migrations
    WHERE name = '016_conversation_ai_takeover'
  ) THEN
    UPDATE conversation_agent_state
    SET mode = 'human_paused',
        pause_reason = 'conversation_opt_in_required',
        updated_at = now()
    WHERE mode = 'active';

    UPDATE agent_jobs
    SET state = 'cancelled',
        completed_at = now(),
        last_error = 'conversation_opt_in_required'
    WHERE state = 'pending'
      AND kind IN ('reply', 'followup');

    INSERT INTO relay_schema_migrations(name)
    VALUES ('016_conversation_ai_takeover');
  END IF;
END $$;
