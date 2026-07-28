ALTER TABLE products
  ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS brand text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS products_category_idx
  ON products(lower(category)) WHERE deleted_at IS NULL AND category <> '';
CREATE INDEX IF NOT EXISTS products_brand_idx
  ON products(lower(brand)) WHERE deleted_at IS NULL AND brand <> '';
