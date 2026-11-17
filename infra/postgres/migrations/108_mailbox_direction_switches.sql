ALTER TABLE account_email_mailboxes ADD COLUMN IF NOT EXISTS receive_enabled boolean;
ALTER TABLE account_email_mailboxes ADD COLUMN IF NOT EXISTS send_enabled boolean;
UPDATE account_email_mailboxes SET receive_enabled=enabled WHERE receive_enabled IS NULL;
UPDATE account_email_mailboxes SET send_enabled=enabled WHERE send_enabled IS NULL;
ALTER TABLE account_email_mailboxes ALTER COLUMN receive_enabled SET DEFAULT true;
ALTER TABLE account_email_mailboxes ALTER COLUMN receive_enabled SET NOT NULL;
ALTER TABLE account_email_mailboxes ALTER COLUMN send_enabled SET DEFAULT true;
ALTER TABLE account_email_mailboxes ALTER COLUMN send_enabled SET NOT NULL;
