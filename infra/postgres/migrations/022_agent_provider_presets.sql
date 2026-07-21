ALTER TABLE agent_provider_settings
  DROP CONSTRAINT IF EXISTS agent_provider_settings_provider_check;

ALTER TABLE agent_provider_settings
  ADD CONSTRAINT agent_provider_settings_provider_check
  CHECK(provider IN ('openai','openrouter','siliconflow','openai_compatible'));
