CREATE TABLE IF NOT EXISTS livechat_end_requests (
  request_id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES livechat_visitors(id) ON DELETE RESTRICT,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE RESTRICT,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
  send_transcript boolean NOT NULL,
  email_id uuid REFERENCES email_messages(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT livechat_end_requests_email_check CHECK (NOT send_transcript OR email_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS livechat_end_requests_visitor_created_idx
  ON livechat_end_requests(visitor_id,created_at DESC);
