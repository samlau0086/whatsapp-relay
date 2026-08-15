ALTER TABLE account_agent_settings
  ADD COLUMN IF NOT EXISTS reply_suggestion_instructions text NOT NULL DEFAULT '';
