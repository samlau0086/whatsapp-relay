ALTER TABLE payment_profiles
  ADD COLUMN IF NOT EXISTS payment_term text NOT NULL DEFAULT 'NET_30';

ALTER TABLE payment_profiles
  DROP CONSTRAINT IF EXISTS payment_profiles_payment_term_check;

ALTER TABLE payment_profiles
  ADD CONSTRAINT payment_profiles_payment_term_check
  CHECK (payment_term IN ('DUE_ON_RECEIPT','NET_10','NET_15','NET_30','NET_45','NET_60','NET_90','NO_DUE_DATE'));