ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_blocked_at timestamptz;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_blocked_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS contacts_whatsapp_blocked_at_idx ON contacts(account_id,whatsapp_blocked_at) WHERE whatsapp_blocked_at IS NOT NULL;
