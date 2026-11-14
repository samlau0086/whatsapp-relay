ALTER TABLE livechat_visitors ADD COLUMN IF NOT EXISTS first_ip text;
ALTER TABLE livechat_visitors ADD COLUMN IF NOT EXISTS last_ip text;
ALTER TABLE livechat_visitors ADD COLUMN IF NOT EXISTS visitor_context jsonb NOT NULL DEFAULT '{}'::jsonb;
