-- NULL 表示使用系统默认模板；旧客户端未提交模板时保留原配置。
ALTER TABLE livechat_channels ADD COLUMN IF NOT EXISTS transcript_template jsonb;
ALTER TABLE livechat_channels DROP CONSTRAINT IF EXISTS livechat_transcript_template_object;
ALTER TABLE livechat_channels ADD CONSTRAINT livechat_transcript_template_object CHECK (transcript_template IS NULL OR jsonb_typeof(transcript_template)='object');
