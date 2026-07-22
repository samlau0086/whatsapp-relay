CREATE TABLE IF NOT EXISTS email_provider_settings (
  provider text PRIMARY KEY CHECK (provider IN ('smtp','resend')),
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_encrypted text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_provider_one_enabled_idx ON email_provider_settings ((enabled)) WHERE enabled;

CREATE TABLE IF NOT EXISTS email_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_send_id uuid UNIQUE NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sender_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  provider text NOT NULL CHECK (provider IN ('smtp','resend')),
  provider_config jsonb NOT NULL,
  provider_secret_encrypted text NOT NULL,
  recipients jsonb NOT NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  message_body text NOT NULL CHECK (char_length(message_body) <= 5000),
  text_body text NOT NULL,
  html_body text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('order_text','order_image','product_cards')),
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  product_ids jsonb,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','retrying','accepted','failed')),
  attempt smallint NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  last_error text,
  accepted_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_messages_claim_idx ON email_messages (available_at,created_at) WHERE status IN ('queued','retrying');
CREATE INDEX IF NOT EXISTS email_messages_conversation_idx ON email_messages (conversation_id,created_at DESC);

CREATE TABLE IF NOT EXISTS email_attachments (
  email_id uuid NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  position smallint NOT NULL,
  file_name text NOT NULL,
  content_id text NOT NULL,
  mime_type text NOT NULL DEFAULT 'image/png',
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  PRIMARY KEY (email_id,position),
  UNIQUE (email_id,content_id)
);
