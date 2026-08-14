ALTER TABLE payment_profiles
  ADD COLUMN IF NOT EXISTS paypal_fee_rate_percent numeric(7,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paypal_fixed_fee numeric(12,2) NOT NULL DEFAULT 0;

ALTER TABLE order_fees
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'manual';

UPDATE order_fees fee
SET source='paypal'
FROM orders order_record
WHERE fee.order_id=order_record.id
  AND fee.name='PayPal 手续费'
  AND COALESCE(order_record.payment_profile_snapshot->>'methodType','')='paypal';
