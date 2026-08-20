ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS tracking_carrier text,
  ADD COLUMN IF NOT EXISTS tracking_number text,
  ADD COLUMN IF NOT EXISTS tracking_url text,
  ADD COLUMN IF NOT EXISTS paypal_tracking_synced_at timestamptz;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_tracking_complete_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_tracking_complete_check CHECK (
    (tracking_carrier IS NULL AND tracking_number IS NULL AND tracking_url IS NULL)
    OR (tracking_carrier IS NOT NULL AND tracking_number IS NOT NULL)
  );
