ALTER TABLE livechat_channels ADD COLUMN IF NOT EXISTS language text NOT NULL DEFAULT 'en';
ALTER TABLE livechat_channels ALTER COLUMN language SET DEFAULT 'en';
