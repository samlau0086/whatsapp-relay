CREATE TABLE IF NOT EXISTS shipping_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_classes_name_unique
  ON shipping_classes(lower(btrim(name)));

CREATE TABLE IF NOT EXISTS shipping_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  currency text NOT NULL REFERENCES currency_settings(code) ON UPDATE CASCADE ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_default OR enabled)
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_templates_name_unique
  ON shipping_templates(lower(btrim(name)));
CREATE UNIQUE INDEX IF NOT EXISTS shipping_templates_single_default
  ON shipping_templates(is_default) WHERE is_default;

CREATE TABLE IF NOT EXISTS shipping_template_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES shipping_templates(id) ON DELETE CASCADE,
  shipping_class_id uuid REFERENCES shipping_classes(id) ON DELETE RESTRICT,
  calculation_mode text NOT NULL CHECK(calculation_mode IN ('quantity','weight')),
  first_item_price numeric(14,2),
  additional_item_price numeric(14,2),
  first_weight numeric(14,6),
  additional_weight numeric(14,6),
  weight_unit text,
  first_weight_price numeric(14,2),
  additional_weight_price numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (
      calculation_mode='quantity'
      AND first_item_price >= 0 AND additional_item_price >= 0
      AND first_weight IS NULL AND additional_weight IS NULL AND weight_unit IS NULL
      AND first_weight_price IS NULL AND additional_weight_price IS NULL
    )
    OR
    (
      calculation_mode='weight'
      AND first_item_price IS NULL AND additional_item_price IS NULL
      AND first_weight > 0 AND additional_weight > 0
      AND weight_unit IN ('g','kg','lbs','oz')
      AND first_weight_price >= 0 AND additional_weight_price >= 0
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS shipping_template_rules_class_unique
  ON shipping_template_rules(template_id,shipping_class_id) WHERE shipping_class_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS shipping_template_rules_default_unique
  ON shipping_template_rules(template_id) WHERE shipping_class_id IS NULL;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS shipping_class_id uuid REFERENCES shipping_classes(id) ON DELETE RESTRICT;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS shipping_class_id uuid REFERENCES shipping_classes(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shipping_class_name text;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS shipping_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS shipping_template_id uuid REFERENCES shipping_templates(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shipping_quote_snapshot jsonb;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_shipping_amount_check;
ALTER TABLE orders ADD CONSTRAINT orders_shipping_amount_check
  CHECK (shipping_amount IS NULL OR shipping_amount >= 0);

CREATE INDEX IF NOT EXISTS products_shipping_class_idx
  ON products(shipping_class_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_shipping_template_idx
  ON orders(shipping_template_id) WHERE deleted_at IS NULL;
