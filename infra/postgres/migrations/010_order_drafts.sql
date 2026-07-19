ALTER TABLE orders ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS translate_on_send boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS target_language text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS translated_text text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sent_at timestamptz;

UPDATE orders SET status='queued',sent_at=COALESCE(sent_at,created_at) WHERE summary_message_id IS NOT NULL AND status='draft';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN ('draft','queued'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  product_name text NOT NULL,
  quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 9999),
  unit_amount numeric(12,2) NOT NULL CHECK(unit_amount>=0),
  image_media_id uuid REFERENCES media(id) ON DELETE RESTRICT,
  UNIQUE(order_id,position)
);

CREATE TABLE IF NOT EXISTS order_fees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position smallint NOT NULL,
  name text NOT NULL,
  amount numeric(12,2) NOT NULL CHECK(amount>0),
  UNIQUE(order_id,position)
);

INSERT INTO order_items(order_id,position,product_name,quantity,unit_amount)
SELECT id,0,COALESCE(product_name,'Manual item'),1,amount FROM orders
WHERE NOT EXISTS(SELECT 1 FROM order_items WHERE order_items.order_id=orders.id);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id,position);
CREATE INDEX IF NOT EXISTS order_fees_order_idx ON order_fees(order_id,position);
