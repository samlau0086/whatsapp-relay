ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS business_status text NOT NULL DEFAULT 'quotation';

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_business_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_business_status_check CHECK (
    business_status IN (
      'quotation',
      'pending_confirmation',
      'pending_payment',
      'paid',
      'processing',
      'shipped',
      'completed',
      'cancelled'
    )
  );

CREATE INDEX IF NOT EXISTS orders_business_status_created_idx
  ON orders(business_status,created_at DESC)
  WHERE deleted_at IS NULL;
