ALTER TABLE messages ADD COLUMN IF NOT EXISTS livechat_end_request_id uuid REFERENCES livechat_end_requests(request_id) ON DELETE RESTRICT;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS livechat_end_request_id uuid REFERENCES livechat_end_requests(request_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS messages_livechat_end_request_idx ON messages(livechat_end_request_id) WHERE livechat_end_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS livechat_end_requests_conversation_created_idx ON livechat_end_requests(conversation_id,created_at DESC);

-- 仅根据已有结束请求补充分隔符，不推测缺少结束记录的历史边界。
INSERT INTO messages(conversation_id,account_id,client_message_id,direction,kind,text_content,status,occurred_at,created_at,livechat_end_request_id)
SELECT conversation_id,account_id,'livechat-end:'||request_id,'out','text','-------Chat Ended-------','sent',created_at,created_at,request_id
FROM livechat_end_requests
ON CONFLICT DO NOTHING;
