-- 未配置的旧渠道继续全天服务；旧客户端未提交时保留已有配置。
ALTER TABLE livechat_channels ADD COLUMN IF NOT EXISTS working_hours jsonb;
ALTER TABLE livechat_channels DROP CONSTRAINT IF EXISTS livechat_working_hours_object;
ALTER TABLE livechat_channels ADD CONSTRAINT livechat_working_hours_object CHECK (working_hours IS NULL OR jsonb_typeof(working_hours)='object');
