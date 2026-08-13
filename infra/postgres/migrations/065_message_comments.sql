CREATE TABLE IF NOT EXISTS message_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS message_comments_message_created_idx ON message_comments(message_id,created_at,id);

CREATE TABLE IF NOT EXISTS message_comment_votes (
  comment_id uuid NOT NULL REFERENCES message_comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value smallint NOT NULL CHECK (value IN (-1,1)),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(comment_id,user_id)
);
