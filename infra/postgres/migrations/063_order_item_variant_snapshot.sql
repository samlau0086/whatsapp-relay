ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS order_items_variant_idx
  ON order_items(variant_id)
  WHERE variant_id IS NOT NULL;
