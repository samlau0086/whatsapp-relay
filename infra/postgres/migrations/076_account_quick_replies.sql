CREATE TABLE IF NOT EXISTS account_quick_replies (
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 160),
  source_message_id text,
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 240),
  text_content text NOT NULL DEFAULT '',
  tags text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'text' CHECK(kind IN ('text','image','audio','video','document')),
  media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id,user_id,id)
);

CREATE INDEX IF NOT EXISTS account_quick_replies_account_user_updated_idx
  ON account_quick_replies(account_id,user_id,updated_at DESC);
