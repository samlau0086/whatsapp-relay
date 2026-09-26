CREATE TABLE IF NOT EXISTS account_email_mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  address text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  is_primary boolean NOT NULL DEFAULT false,
  imap_host text NOT NULL,
  imap_port integer NOT NULL,
  imap_username text NOT NULL,
  imap_secret_encrypted text NOT NULL,
  smtp_host text NOT NULL,
  smtp_port integer NOT NULL,
  smtp_username text NOT NULL,
  smtp_secret_encrypted text NOT NULL,
  smtp_tls text NOT NULL CHECK (smtp_tls IN ('tls','starttls')),
  uid_validity text,
  last_uid bigint,
  last_error text,
  last_synced_at timestamptz,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  claimed_until timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS account_email_mailboxes_address_unique ON account_email_mailboxes(lower(address));
CREATE UNIQUE INDEX IF NOT EXISTS account_email_mailboxes_primary_unique ON account_email_mailboxes(account_id) WHERE is_primary AND enabled;
CREATE INDEX IF NOT EXISTS account_email_mailboxes_sync_idx ON account_email_mailboxes(next_sync_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS message_email_details (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  mailbox_id uuid REFERENCES account_email_mailboxes(id) ON DELETE SET NULL,
  subject text NOT NULL,
  from_email text NOT NULL,
  to_emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  rfc_message_id text,
  in_reply_to text,
  references_header text,
  attachment_warning text,
  email_job_id uuid UNIQUE REFERENCES email_messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_email_details_mailbox_idx ON message_email_details(mailbox_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS message_email_details_rfc_unique ON message_email_details(mailbox_id,rfc_message_id) WHERE mailbox_id IS NOT NULL AND rfc_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_inbound_receipts (
  mailbox_id uuid NOT NULL REFERENCES account_email_mailboxes(id) ON DELETE CASCADE,
  uid_validity text NOT NULL,
  uid bigint NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox_id,uid_validity,uid)
);
CREATE TABLE IF NOT EXISTS message_email_attachments (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  position smallint NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  PRIMARY KEY(message_id,position)
);
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS mailbox_id uuid REFERENCES account_email_mailboxes(id) ON DELETE SET NULL;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS in_reply_to text;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS references_header text;
ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_content_type_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_content_type_check CHECK(content_type IN ('text','order_text','order_image','order_pdf','product_cards'));

-- Preserve existing order/product email history in the shared conversation timeline.
INSERT INTO messages(conversation_id,account_id,sender_user_id,client_message_id,direction,kind,text_content,status,occurred_at)
SELECT e.conversation_id,c.account_id,e.sender_user_id,'email:'||e.id::text,'out','text',e.text_body,
  CASE WHEN e.status='accepted' THEN 'sent'::delivery_status WHEN e.status='failed' THEN 'failed'::delivery_status ELSE 'queued'::delivery_status END,e.created_at
FROM email_messages e JOIN conversations c ON c.id=e.conversation_id
ON CONFLICT(account_id,client_message_id) DO NOTHING;
INSERT INTO message_email_details(message_id,subject,from_email,to_emails,rfc_message_id,email_job_id)
SELECT m.id,e.subject,e.provider_config->>'fromEmail',COALESCE((SELECT jsonb_agg(item->>'email') FROM jsonb_array_elements(e.recipients) item),'[]'::jsonb),'<email-'||e.id::text||'@relaydesk.local>',e.id
FROM email_messages e JOIN conversations c ON c.id=e.conversation_id JOIN messages m ON m.account_id=c.account_id AND m.client_message_id='email:'||e.id::text
ON CONFLICT(message_id) DO NOTHING;
INSERT INTO message_email_attachments(message_id,media_id,position,file_name,mime_type,byte_size)
SELECT d.message_id,a.media_id,a.position,a.file_name,a.mime_type,a.byte_size FROM email_attachments a JOIN message_email_details d ON d.email_job_id=a.email_id
ON CONFLICT(message_id,position) DO NOTHING;
