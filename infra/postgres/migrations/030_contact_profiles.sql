ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS note text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS contact_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '',
  email text NOT NULL,
  is_primary boolean NOT NULL DEFAULT false,
  position smallint NOT NULL DEFAULT 0 CHECK(position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contact_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK(type IN ('phone','wechat','telegram','line','website','other')),
  label text NOT NULL DEFAULT '',
  value text NOT NULL,
  position smallint NOT NULL DEFAULT 0 CHECK(position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_emails_contact_email_unique
  ON contact_emails(contact_id,lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS contact_emails_one_primary_unique
  ON contact_emails(contact_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS contact_emails_contact_position_idx
  ON contact_emails(contact_id,position,id);
CREATE INDEX IF NOT EXISTS contact_methods_contact_position_idx
  ON contact_methods(contact_id,position,id);
CREATE INDEX IF NOT EXISTS contacts_account_updated_idx
  ON contacts(account_id,updated_at DESC,id);
