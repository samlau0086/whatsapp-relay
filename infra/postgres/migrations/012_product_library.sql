CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_product_id uuid UNIQUE NOT NULL,
  name text NOT NULL,
  default_unit_amount numeric(12,2) NOT NULL CHECK(default_unit_amount>=0),
  currency text NOT NULL CHECK(currency IN ('USD','CNY','EUR','GBP','JPY','HKD','SGD','AUD','CAD','AED')),
  image_media_id uuid REFERENCES media(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS product_labels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#E8EEF7'
);

CREATE UNIQUE INDEX IF NOT EXISTS product_labels_product_name_unique
  ON product_labels(product_id,lower(name));
CREATE INDEX IF NOT EXISTS products_active_updated_idx
  ON products(updated_at DESC,id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS product_labels_name_idx
  ON product_labels(lower(name));

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items(product_id) WHERE product_id IS NOT NULL;
