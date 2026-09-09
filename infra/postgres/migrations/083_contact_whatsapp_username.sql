ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_username text;
CREATE INDEX IF NOT EXISTS contacts_whatsapp_username_idx ON contacts(account_id, whatsapp_username);
