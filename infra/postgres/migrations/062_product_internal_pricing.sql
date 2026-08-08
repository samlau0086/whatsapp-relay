ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS internal_note text NOT NULL DEFAULT '';

ALTER TABLE product_price_tiers
  ADD COLUMN IF NOT EXISTS cost_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS profit_margin numeric(10,4);
