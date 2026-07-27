ALTER TABLE products
  ADD COLUMN IF NOT EXISTS weight_amount numeric(14,6),
  ADD COLUMN IF NOT EXISTS weight_unit text;

ALTER TABLE products DROP CONSTRAINT IF EXISTS products_weight_pair_check;
ALTER TABLE products ADD CONSTRAINT products_weight_pair_check CHECK (
  (weight_amount IS NULL AND weight_unit IS NULL)
  OR (weight_amount > 0 AND weight_unit IN ('g','kg','lbs','oz'))
);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS weight_unit text NOT NULL DEFAULT 'kg';

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_weight_unit_check;
ALTER TABLE orders ADD CONSTRAINT orders_weight_unit_check
  CHECK (weight_unit IN ('g','kg','lbs','oz'));

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS weight_amount numeric(14,6),
  ADD COLUMN IF NOT EXISTS weight_unit text;

ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_weight_pair_check;
ALTER TABLE order_items ADD CONSTRAINT order_items_weight_pair_check CHECK (
  (weight_amount IS NULL AND weight_unit IS NULL)
  OR (weight_amount > 0 AND weight_unit IN ('g','kg','lbs','oz'))
);
