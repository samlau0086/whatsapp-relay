ALTER TABLE products
  ADD COLUMN IF NOT EXISTS supplier_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS internal_note text NOT NULL DEFAULT '';

ALTER TABLE product_price_tiers
  ADD COLUMN IF NOT EXISTS cost_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS profit_margin numeric(10,4);

DO $$ BEGIN
  IF to_regclass('public.product_variant_price_tiers') IS NOT NULL THEN
    ALTER TABLE product_variant_price_tiers
      ADD COLUMN IF NOT EXISTS cost_amount numeric(12,2),
      ADD COLUMN IF NOT EXISTS profit_margin numeric(10,4);
  END IF;
END $$;

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS internal_note_snapshot text NOT NULL DEFAULT '';
