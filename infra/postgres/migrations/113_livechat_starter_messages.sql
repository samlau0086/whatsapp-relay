-- 每个渠道独立保存有序的快捷引导消息；旧渠道默认不显示。
ALTER TABLE livechat_channels ADD COLUMN IF NOT EXISTS starter_messages jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(starter_messages) = 'array' AND jsonb_array_length(starter_messages) <= 50);
