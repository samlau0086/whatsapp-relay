CREATE TABLE IF NOT EXISTS tts_provider_settings (
  provider text PRIMARY KEY CHECK (provider IN ('openai','elevenlabs','azure','openai_compatible')),
  enabled boolean NOT NULL DEFAULT false,
  api_key_encrypted text,
  base_url text NOT NULL,
  model text NOT NULL DEFAULT '',
  voice text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS tts_provider_one_enabled_idx ON tts_provider_settings ((enabled)) WHERE enabled;
