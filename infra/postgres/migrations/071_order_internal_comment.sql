ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS internal_comment text NOT NULL DEFAULT '';
