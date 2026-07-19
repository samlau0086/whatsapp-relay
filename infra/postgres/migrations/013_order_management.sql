CREATE TABLE IF NOT EXISTS order_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  number_template text NOT NULL DEFAULT '{YYYY}{MM}{DD}-{SEQ:3}',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO order_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS order_daily_sequences (
  sequence_date date PRIMARY KEY,
  last_value integer NOT NULL CHECK(last_value>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS display_order_number text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sequence_date date;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS daily_sequence integer;

UPDATE orders
SET display_order_number=lpad(order_number::text,6,'0')
WHERE display_order_number IS NULL;

ALTER TABLE orders ALTER COLUMN display_order_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS orders_display_number_unique ON orders(display_order_number);
CREATE INDEX IF NOT EXISTS orders_management_created_idx ON orders(created_at DESC,id DESC) WHERE deleted_at IS NULL;
