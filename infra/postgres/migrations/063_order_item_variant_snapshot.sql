CREATE TABLE IF NOT EXISTS product_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  attributes jsonb NOT NULL,
  sku text NOT NULL,
  default_unit_amount numeric(12,2) NOT NULL CHECK(default_unit_amount >= 0),
  image_media_id uuid REFERENCES media(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(product_id,attributes)
);

CREATE UNIQUE INDEX IF NOT EXISTS product_variants_sku_idx
  ON product_variants(lower(btrim(sku)));

CREATE TABLE IF NOT EXISTS product_variant_price_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  min_quantity integer NOT NULL CHECK(min_quantity BETWEEN 1 AND 999999),
  unit_amount numeric(12,2) NOT NULL CHECK(unit_amount >= 0),
  cost_amount numeric(12,2),
  profit_margin numeric(10,4),
  UNIQUE(variant_id,min_quantity)
);

CREATE INDEX IF NOT EXISTS product_variant_price_tiers_variant_quantity_idx
  ON product_variant_price_tiers(variant_id,min_quantity);

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS order_items_variant_idx
  ON order_items(variant_id)
  WHERE variant_id IS NOT NULL;
