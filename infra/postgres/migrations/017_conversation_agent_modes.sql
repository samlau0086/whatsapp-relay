-- Split AI takeover into a cautious mode and a fully autonomous mode.
ALTER TABLE conversation_agent_state
  DROP CONSTRAINT IF EXISTS conversation_agent_state_mode_check;

UPDATE conversation_agent_state
SET mode = 'cautious', updated_at = now()
WHERE mode = 'active';

ALTER TABLE conversation_agent_state
  ALTER COLUMN mode SET DEFAULT 'human_paused';

ALTER TABLE conversation_agent_state
  ADD CONSTRAINT conversation_agent_state_mode_check
  CHECK (mode IN ('cautious', 'full', 'human_paused'));
