ALTER TABLE order_settings
  ADD COLUMN IF NOT EXISTS inq_template jsonb;

UPDATE order_settings
SET inq_template = COALESCE(inq_template, image_template)
WHERE singleton = true;
