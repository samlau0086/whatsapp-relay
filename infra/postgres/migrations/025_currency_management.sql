CREATE TABLE IF NOT EXISTS currency_settings (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),
  name text NOT NULL,
  rate numeric(20,8) NOT NULL CHECK (rate > 0),
  is_base boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS currency_settings_one_base_idx
  ON currency_settings ((is_base)) WHERE is_base;

INSERT INTO currency_settings(code,name,rate,is_base,position)
SELECT * FROM (VALUES
  ('USD','美元',1::numeric,true,0),('CNY','人民币',7.2,false,1),('EUR','欧元',0.92,false,2),
  ('GBP','英镑',0.78,false,3),('JPY','日元',157,false,4),('HKD','港币',7.8,false,5),
  ('SGD','新加坡元',1.35,false,6),('AUD','澳元',1.5,false,7),('CAD','加元',1.37,false,8),
  ('AED','阿联酋迪拉姆',3.6725,false,9)) defaults(code,name,rate,is_base,position)
WHERE NOT EXISTS (SELECT 1 FROM currency_settings)
ON CONFLICT(code) DO NOTHING;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_currency_check;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_currency_check;
