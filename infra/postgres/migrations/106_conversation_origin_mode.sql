ALTER TABLE conversations ADD COLUMN IF NOT EXISTS origin_mode text
  CHECK (origin_mode IN ('email','whatsapp','livechat','messenger'));

-- 固定原始类型，避免编辑客户联系方式后改变合并规则。
UPDATE conversations c SET origin_mode=CASE
  WHEN a.platform='whatsapp' AND (
    (co.provider_user_id IS NULL AND co.phone_e164 IS NULL AND co.whatsapp_username IS NULL)
    OR (EXISTS(SELECT 1 FROM messages m JOIN message_email_details e ON e.message_id=m.id WHERE m.conversation_id=c.id)
      AND NOT EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND NOT EXISTS(SELECT 1 FROM message_email_details e WHERE e.message_id=m.id)))
  ) THEN 'email' ELSE a.platform::text END
FROM contacts co,channel_accounts a
WHERE co.id=c.contact_id AND a.id=c.account_id AND c.origin_mode IS NULL;

CREATE OR REPLACE FUNCTION relay_set_conversation_origin_mode()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.origin_mode IS NULL THEN
    SELECT CASE WHEN a.platform='whatsapp' AND co.provider_user_id IS NULL
      AND co.phone_e164 IS NULL AND co.whatsapp_username IS NULL THEN 'email' ELSE a.platform::text END
      INTO NEW.origin_mode FROM contacts co JOIN channel_accounts a ON a.id=NEW.account_id WHERE co.id=NEW.contact_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversations_origin_mode ON conversations;
CREATE TRIGGER conversations_origin_mode BEFORE INSERT ON conversations
FOR EACH ROW EXECUTE FUNCTION relay_set_conversation_origin_mode();
