CREATE TABLE IF NOT EXISTS transcription_provider_settings (
  provider text PRIMARY KEY CHECK (provider IN ('openai','openai_compatible')),
  enabled boolean NOT NULL DEFAULT false,
  api_key_encrypted text,
  base_url text NOT NULL,
  model text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS transcription_provider_one_enabled_idx
  ON transcription_provider_settings ((enabled)) WHERE enabled;

-- Migrate the previous coupled transcription setting once, without overwriting
-- an independently configured transcription provider.
INSERT INTO transcription_provider_settings(provider, enabled, api_key_encrypted, base_url, model, updated_by)
SELECT provider, enabled, api_key_encrypted, base_url, transcription_model, updated_by
FROM translation_provider_settings
WHERE enabled AND api_key_encrypted IS NOT NULL
ON CONFLICT (provider) DO NOTHING;
