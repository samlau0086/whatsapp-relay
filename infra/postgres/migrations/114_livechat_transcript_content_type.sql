-- LiveChat transcript 使用独立的邮件类型，允许其进入统一邮件队列。
ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_content_type_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_content_type_check
  CHECK (content_type IN ('text','order_text','order_image','order_pdf','product_cards','livechat_transcript'));
