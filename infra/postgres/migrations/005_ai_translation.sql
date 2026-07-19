CREATE TABLE IF NOT EXISTS user_translation_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  agent_language text NOT NULL DEFAULT 'zh-CN',
  customer_language text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS translation_provider_settings (
  provider text PRIMARY KEY CHECK (provider IN ('openai','openai_compatible')),
  enabled boolean NOT NULL DEFAULT false,
  api_key_encrypted text,
  base_url text NOT NULL,
  model text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS translation_provider_one_enabled_idx
  ON translation_provider_settings ((enabled)) WHERE enabled;

CREATE TABLE IF NOT EXISTS message_translations (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_language text NOT NULL,
  translated_text text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id,target_language)
);
