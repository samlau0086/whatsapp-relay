CREATE TABLE IF NOT EXISTS livechat_presence (
  visitor_id uuid NOT NULL REFERENCES livechat_visitors(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  sequence bigint NOT NULL,
  visible boolean NOT NULL,
  connected boolean NOT NULL,
  page_url text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, session_id)
);
