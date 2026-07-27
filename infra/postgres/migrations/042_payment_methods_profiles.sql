CREATE TABLE IF NOT EXISTS payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK(type IN ('paypal','bank_transfer','western_union','wise','moneygram','stripe_payment_link','custom')),
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  legacy_key text UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS payment_methods_active_sort_idx
  ON payment_methods(sort_order,created_at,id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS payment_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method_id uuid NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  public_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  instructions text NOT NULL DEFAULT '',
  environment text CHECK(environment IS NULL OR environment IN ('sandbox','live')),
  sandbox_client_id_encrypted text,
  sandbox_client_secret_encrypted text,
  live_client_id_encrypted text,
  live_client_secret_encrypted text,
  reference_template text NOT NULL DEFAULT 'Order #{{orderNumber}}',
  note_template text NOT NULL DEFAULT '{{orderNotes}}',
  item_name_template text NOT NULL DEFAULT '{{productName}}',
  legacy_key text UNIQUE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX IF NOT EXISTS payment_profiles_method_active_idx
  ON payment_profiles(method_id,created_at,id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payment_profiles_active_name_unique
  ON payment_profiles(method_id,lower(name)) WHERE deleted_at IS NULL;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_profile_id uuid REFERENCES payment_profiles(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_profile_snapshot jsonb;
CREATE INDEX IF NOT EXISTS orders_payment_profile_idx ON orders(payment_profile_id) WHERE deleted_at IS NULL;

ALTER TABLE order_payment_requests ADD COLUMN IF NOT EXISTS payment_profile_id uuid REFERENCES payment_profiles(id) ON DELETE SET NULL;
ALTER TABLE order_payment_requests ADD COLUMN IF NOT EXISTS payment_profile_snapshot jsonb;

INSERT INTO payment_methods(type,name,enabled,sort_order,legacy_key)
SELECT 'paypal','PayPal',enabled,0,'legacy_paypal'
FROM paypal_settings
WHERE singleton=true
ON CONFLICT(legacy_key) DO UPDATE SET
  enabled=EXCLUDED.enabled,
  updated_at=now();

INSERT INTO payment_profiles(
  method_id,name,enabled,public_fields,instructions,environment,
  sandbox_client_id_encrypted,sandbox_client_secret_encrypted,
  live_client_id_encrypted,live_client_secret_encrypted,
  reference_template,note_template,item_name_template,legacy_key
)
SELECT
  method.id,'Default',settings.enabled,'[]'::jsonb,'',settings.environment,
  settings.sandbox_client_id_encrypted,settings.sandbox_client_secret_encrypted,
  settings.live_client_id_encrypted,settings.live_client_secret_encrypted,
  settings.reference_template,settings.note_template,settings.item_name_template,
  'legacy_paypal_default'
FROM paypal_settings settings
JOIN payment_methods method ON method.legacy_key='legacy_paypal'
WHERE settings.singleton=true
ON CONFLICT(legacy_key) DO UPDATE SET
  enabled=EXCLUDED.enabled,
  environment=EXCLUDED.environment,
  sandbox_client_id_encrypted=COALESCE(payment_profiles.sandbox_client_id_encrypted,EXCLUDED.sandbox_client_id_encrypted),
  sandbox_client_secret_encrypted=COALESCE(payment_profiles.sandbox_client_secret_encrypted,EXCLUDED.sandbox_client_secret_encrypted),
  live_client_id_encrypted=COALESCE(payment_profiles.live_client_id_encrypted,EXCLUDED.live_client_id_encrypted),
  live_client_secret_encrypted=COALESCE(payment_profiles.live_client_secret_encrypted,EXCLUDED.live_client_secret_encrypted),
  reference_template=EXCLUDED.reference_template,
  note_template=EXCLUDED.note_template,
  item_name_template=EXCLUDED.item_name_template,
  updated_at=now();

UPDATE order_payment_requests request
SET payment_profile_id=profile.id,
    payment_profile_snapshot=jsonb_build_object(
      'methodId',method.id,'methodType','paypal','methodName',method.name,
      'profileId',profile.id,'profileName',profile.name,'environment',request.environment,
      'summary',method.name || ' · ' || profile.name,'publicFields','[]'::jsonb,'instructions',''
    )
FROM payment_profiles profile
JOIN payment_methods method ON method.id=profile.method_id
WHERE profile.legacy_key='legacy_paypal_default'
  AND request.payment_profile_id IS NULL;
