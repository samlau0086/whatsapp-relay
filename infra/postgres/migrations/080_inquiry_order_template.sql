ALTER TABLE order_settings
  ADD COLUMN IF NOT EXISTS inq_template jsonb;
