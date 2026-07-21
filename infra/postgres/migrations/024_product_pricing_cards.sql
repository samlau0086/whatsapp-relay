ALTER TABLE products ADD COLUMN IF NOT EXISTS sku text;

UPDATE products
SET sku='SKU-' || upper(substr(replace(id::text,'-',''),1,12))
WHERE sku IS NULL OR btrim(sku)='';

ALTER TABLE products ALTER COLUMN sku SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS products_active_sku_unique
  ON products(lower(btrim(sku))) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS product_price_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_quantity integer NOT NULL CHECK(min_quantity BETWEEN 1 AND 999999),
  unit_amount numeric(12,2) NOT NULL CHECK(unit_amount>=0),
  UNIQUE(product_id,min_quantity)
);

INSERT INTO product_price_tiers(product_id,min_quantity,unit_amount)
SELECT id,1,default_unit_amount FROM products
ON CONFLICT(product_id,min_quantity) DO NOTHING;

CREATE INDEX IF NOT EXISTS product_price_tiers_product_quantity_idx
  ON product_price_tiers(product_id,min_quantity);

CREATE TABLE IF NOT EXISTS product_card_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  template jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO product_card_settings(singleton,template)
VALUES(true,'{"version":1,"blocks":[{"id":"image","type":"productImage","imageSize":"large","imageFit":"cover","showPlaceholder":true,"backgroundColor":"#F2F6F4"},{"id":"name","type":"productName","label":"Product","fontSize":"large","textColor":"#153F2F","backgroundColor":"#FFFFFF","align":"left"},{"id":"sku","type":"sku","label":"SKU","fontSize":"small","textColor":"#607168","backgroundColor":"#FFFFFF","align":"left"},{"id":"prices","type":"priceTiers","label":"Pricing","fontSize":"medium","textColor":"#20372D","backgroundColor":"#F2F8F5","align":"left"},{"id":"tags","type":"tags","label":"","fontSize":"small","textColor":"#31644D","backgroundColor":"#EAF7F0","align":"left"}]}'::jsonb)
ON CONFLICT(singleton) DO NOTHING;
