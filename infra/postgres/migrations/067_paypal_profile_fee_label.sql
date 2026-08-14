ALTER TABLE payment_profiles
  ADD COLUMN IF NOT EXISTS paypal_fee_label text NOT NULL DEFAULT 'PayPal 手续费';
