ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS sandbox_client_id_encrypted text;
ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS sandbox_client_secret_encrypted text;
ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS live_client_id_encrypted text;
ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS live_client_secret_encrypted text;

UPDATE paypal_settings
SET sandbox_client_id_encrypted=COALESCE(sandbox_client_id_encrypted,client_id_encrypted),
    sandbox_client_secret_encrypted=COALESCE(sandbox_client_secret_encrypted,client_secret_encrypted)
WHERE environment='sandbox';

UPDATE paypal_settings
SET live_client_id_encrypted=COALESCE(live_client_id_encrypted,client_id_encrypted),
    live_client_secret_encrypted=COALESCE(live_client_secret_encrypted,client_secret_encrypted)
WHERE environment='live';
