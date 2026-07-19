CREATE TABLE IF NOT EXISTS conversation_translation_preferences (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  agent_language text NOT NULL DEFAULT 'zh-CN',
  customer_language text NOT NULL DEFAULT 'en',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,conversation_id)
);

INSERT INTO conversation_translation_preferences(user_id,conversation_id,enabled,agent_language,customer_language,created_at,updated_at)
SELECT preference.user_id,conversation.id,preference.enabled,preference.agent_language,preference.customer_language,preference.created_at,preference.updated_at
FROM user_translation_preferences preference
CROSS JOIN conversations conversation
ON CONFLICT(user_id,conversation_id) DO NOTHING;

DROP TABLE IF EXISTS user_translation_preferences;
