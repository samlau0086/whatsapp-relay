ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_stage text NOT NULL DEFAULT 'new';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_customer_stage_check') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_customer_stage_check CHECK (customer_stage IN ('new','considering','qualified','won','lost'));
  END IF;
END $$;

ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remind_at timestamptz NOT NULL,
  dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(conversation_id,user_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number bigserial UNIQUE NOT NULL,
  client_order_id uuid UNIQUE NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  product_name text,
  amount numeric(12,2) NOT NULL CHECK(amount>0),
  currency text NOT NULL CHECK(currency IN ('USD','CNY','EUR','GBP','JPY','HKD','SGD','AUD','CAD','AED')),
  description text,
  summary_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_attachments (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  ordinal smallint NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
  PRIMARY KEY(order_id,media_id),
  UNIQUE(order_id,ordinal)
);

CREATE INDEX IF NOT EXISTS reminders_user_due_idx ON reminders(user_id,remind_at) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS orders_conversation_created_idx ON orders(conversation_id,created_at DESC);
