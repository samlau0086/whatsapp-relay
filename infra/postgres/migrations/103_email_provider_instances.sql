CREATE TABLE IF NOT EXISTS email_provider_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  provider text NOT NULL CHECK (provider IN ('smtp','resend')),
  enabled boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false CHECK (NOT is_default OR enabled),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_encrypted text,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS email_provider_instances_default_idx ON email_provider_instances (is_default) WHERE is_default;
CREATE TABLE IF NOT EXISTS account_email_providers (
  account_id uuid PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,
  provider_id uuid NOT NULL REFERENCES email_provider_instances(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 固定 ID 保证重复启动不重复导入旧配置；旧表与排队中的发送快照保持不变。
INSERT INTO email_provider_instances(id,name,provider,enabled,is_default,config,secret_encrypted,updated_by,created_at,updated_at)
SELECT md5('relaydesk-email-'||provider)::uuid,CASE provider WHEN 'smtp' THEN '标准 SMTP' ELSE 'Resend API' END,
  provider,enabled,enabled,config,secret_encrypted,updated_by,created_at,updated_at
FROM email_provider_settings
WHERE NOT EXISTS (SELECT 1 FROM email_provider_instances)
ON CONFLICT DO NOTHING;
