-- 只修正没有访客身份且仅包含邮件的会话，保留真实访客及已有时间线关联。
UPDATE conversations c SET origin_mode='email'
FROM channel_accounts a
WHERE a.id=c.account_id AND a.platform='livechat' AND c.origin_mode='livechat'
  AND NOT EXISTS(SELECT 1 FROM livechat_visitors v WHERE v.account_id=c.account_id AND v.contact_id=c.contact_id)
  AND EXISTS(SELECT 1 FROM messages m JOIN message_email_details d ON d.message_id=m.id WHERE m.conversation_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id
    AND NOT EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id));

CREATE OR REPLACE FUNCTION relay_set_conversation_origin_mode()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_mode IS NULL THEN
    SELECT CASE
      WHEN a.platform='livechat' AND NOT EXISTS(
        SELECT 1 FROM livechat_visitors v WHERE v.account_id=NEW.account_id AND v.contact_id=NEW.contact_id
      ) THEN 'email'
      WHEN a.platform='whatsapp' AND co.provider_user_id IS NULL
        AND co.phone_e164 IS NULL AND co.whatsapp_username IS NULL THEN 'email'
      ELSE a.platform::text END
      INTO NEW.origin_mode FROM contacts co JOIN channel_accounts a ON a.id=NEW.account_id WHERE co.id=NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$;
