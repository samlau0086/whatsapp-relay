-- Initialize every newly inserted conversation from its account-level AI setting.
-- Existing conversations and their current takeover modes are intentionally unchanged.
ALTER TABLE account_agent_settings
  ADD COLUMN IF NOT EXISTS default_conversation_mode text NOT NULL DEFAULT 'human_paused';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'account_agent_settings_default_conversation_mode_check'
      AND conrelid = 'account_agent_settings'::regclass
  ) THEN
    ALTER TABLE account_agent_settings
      ADD CONSTRAINT account_agent_settings_default_conversation_mode_check
      CHECK (default_conversation_mode IN ('cautious', 'full', 'human_paused'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION initialize_conversation_agent_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO conversation_agent_state(conversation_id, mode)
  VALUES (
    NEW.id,
    COALESCE(
      (
        SELECT settings.default_conversation_mode
        FROM account_agent_settings settings
        WHERE settings.account_id = NEW.account_id
      ),
      'human_paused'
    )
  )
  ON CONFLICT(conversation_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_initialize_agent_state ON conversations;
CREATE TRIGGER conversations_initialize_agent_state
AFTER INSERT ON conversations
FOR EACH ROW
EXECUTE FUNCTION initialize_conversation_agent_state();
