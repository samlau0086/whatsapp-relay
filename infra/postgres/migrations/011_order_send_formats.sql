ALTER TABLE orders ADD COLUMN IF NOT EXISTS send_format text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rendered_media_id uuid REFERENCES media(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_send_format_check') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_send_format_check
      CHECK(send_format IS NULL OR send_format IN ('text','image'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS orders_conversation_active_idx
  ON orders(conversation_id,created_at DESC) WHERE deleted_at IS NULL;
