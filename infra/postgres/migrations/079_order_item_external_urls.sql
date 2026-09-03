ALTER TABLE order_items ADD COLUMN IF NOT EXISTS image_url text;

UPDATE order_items i
SET image_url = p.image_url
FROM products p
WHERE i.product_id = p.id
  AND i.image_media_id IS NULL
  AND i.image_url IS NULL
  AND p.image_url IS NOT NULL;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_image_source_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_image_source_check
  CHECK (image_media_id IS NOT NULL OR image_url IS NULL OR image_url ~* '^https?://');