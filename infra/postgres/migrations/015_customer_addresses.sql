CREATE TABLE IF NOT EXISTS contact_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  label text NOT NULL,
  recipient_name text,
  phone text,
  address text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_id uuid REFERENCES contact_addresses(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address_snapshot jsonb;
CREATE INDEX IF NOT EXISTS contact_addresses_contact_idx ON contact_addresses(contact_id,created_at DESC);
