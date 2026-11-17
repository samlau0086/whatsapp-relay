ALTER TABLE account_email_mailboxes DROP CONSTRAINT IF EXISTS account_email_mailboxes_auth_type_check;
ALTER TABLE account_email_mailboxes ADD CONSTRAINT account_email_mailboxes_auth_type_check CHECK(auth_type IN ('password','microsoft','google'));
ALTER TABLE account_email_mailboxes ADD COLUMN IF NOT EXISTS gmail_label_id text;
ALTER TABLE account_email_mailboxes ADD COLUMN IF NOT EXISTS gmail_history_id text;
CREATE TABLE IF NOT EXISTS gmail_inbound_receipts (
  mailbox_id uuid NOT NULL REFERENCES account_email_mailboxes(id) ON DELETE CASCADE,
  gmail_message_id text NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(mailbox_id,gmail_message_id)
);
