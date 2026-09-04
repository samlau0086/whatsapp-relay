ALTER TABLE products ADD COLUMN IF NOT EXISTS is_in_stock boolean NOT NULL DEFAULT true;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_out_of_stock boolean NOT NULL DEFAULT false;
