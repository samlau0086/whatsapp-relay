-- 邮件属于渠道邮箱档案，联系人邮箱仅作为读取关联，不是所有权。
ALTER TABLE messages ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE email_messages ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES channel_accounts(id) ON DELETE CASCADE;
UPDATE email_messages e SET account_id=c.account_id FROM conversations c WHERE c.id=e.conversation_id AND e.account_id IS NULL;
ALTER TABLE email_messages ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE email_messages ALTER COLUMN contact_id DROP NOT NULL;
ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_conversation_id_fkey;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_conversation_id_fkey FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_contact_id_fkey;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_contact_id_fkey FOREIGN KEY(contact_id) REFERENCES contacts(id) ON DELETE SET NULL;
CREATE OR REPLACE FUNCTION relay_email_job_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT account_id INTO NEW.account_id FROM conversations WHERE id=NEW.conversation_id;
  IF NEW.account_id IS NULL THEN RAISE EXCEPTION 'email_account_required'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_archive_job_account ON email_messages;
CREATE TRIGGER email_archive_job_account BEFORE INSERT ON email_messages
FOR EACH ROW EXECUTE FUNCTION relay_email_job_account();
CREATE TABLE IF NOT EXISTS email_archive_addresses (
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
  email text NOT NULL,
  PRIMARY KEY(message_id,email)
);
CREATE INDEX IF NOT EXISTS email_archive_addresses_lookup ON email_archive_addresses(account_id,email,message_id);
CREATE INDEX IF NOT EXISTS contact_emails_address_lookup ON contact_emails(lower(btrim(email)),contact_id);

CREATE OR REPLACE FUNCTION relay_conversation_messages(target uuid)
RETURNS TABLE(message_id uuid,conversation_id uuid) LANGUAGE sql STABLE AS $$
  WITH members AS (
    SELECT c.id,c.account_id,c.contact_id FROM conversations c
    WHERE c.id IN (SELECT relay_conversation_members(target))
  ), visible AS (
    SELECT m.id message_id,c.id conversation_id FROM members c JOIN messages m ON m.conversation_id=c.id
    WHERE NOT EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id)
    UNION ALL
    SELECT a.message_id,c.id FROM members c JOIN contact_emails e ON e.contact_id=c.contact_id
    JOIN email_archive_addresses a ON a.account_id=c.account_id AND a.email=lower(btrim(e.email))
  )
  SELECT DISTINCT ON (v.message_id) v.message_id,v.conversation_id FROM visible v
  ORDER BY v.message_id,(v.conversation_id=target) DESC,v.conversation_id;
$$;

CREATE OR REPLACE FUNCTION relay_refresh_conversation_summary(target_conversation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE latest messages%ROWTYPE;
BEGIN
  IF target_conversation_id::text=current_setting('relay.deleting_email_conversation',true) THEN RETURN; END IF;
  -- 源成员只刷新自己的摘要，主会话包含已合并成员。
  SELECT m.* INTO latest FROM messages m
  JOIN relay_conversation_messages(target_conversation_id) visible ON visible.message_id=m.id
  WHERE visible.conversation_id=target_conversation_id OR NOT EXISTS(
    SELECT 1 FROM conversation_timeline_merges WHERE source_id=target_conversation_id)
  ORDER BY m.occurred_at DESC,m.id DESC LIMIT 1;
  UPDATE conversations SET last_message_id=latest.id,last_message_text=latest.text_content,
    last_message_kind=latest.kind,last_message_direction=latest.direction,last_message_status=latest.status,
    last_message_at=latest.occurred_at,last_message_sender_provider_user_id=latest.sender_provider_user_id,
    last_message_sender_name=latest.sender_display_name,summary_updated_at=now()
  WHERE id=target_conversation_id;
END $$;

CREATE OR REPLACE FUNCTION relay_refresh_email_readers(target uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  FOR item IN SELECT DISTINCT c.id FROM email_archive_addresses a
    JOIN contact_emails e ON lower(btrim(e.email))=a.email
    JOIN conversations c ON c.contact_id=e.contact_id AND c.account_id=a.account_id
    WHERE a.message_id=target ORDER BY c.id
  LOOP PERFORM relay_refresh_conversation_summary(item.id); END LOOP;
END $$;

CREATE OR REPLACE FUNCTION relay_index_email_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE readers uuid[]; reader uuid;
BEGIN
  IF TG_OP<>'INSERT' THEN
    SELECT array_agg(DISTINCT c.id) INTO readers FROM email_archive_addresses a
      JOIN contact_emails e ON lower(btrim(e.email))=a.email
      JOIN conversations c ON c.contact_id=e.contact_id AND c.account_id=a.account_id
      WHERE a.message_id=OLD.message_id;
    DELETE FROM email_archive_addresses WHERE message_id=OLD.message_id;
  END IF;
  INSERT INTO email_archive_addresses(message_id,account_id,email)
  SELECT NEW.message_id,m.account_id,lower(btrim(address)) FROM messages m
  CROSS JOIN LATERAL (
    SELECT NEW.from_email address WHERE m.direction='in'
    UNION SELECT jsonb_array_elements_text(NEW.to_emails) WHERE m.direction='out'
  ) addresses WHERE m.id=NEW.message_id AND btrim(address)<>'' ON CONFLICT DO NOTHING;
  PERFORM relay_refresh_email_readers(NEW.message_id);
  FOREACH reader IN ARRAY COALESCE(readers,ARRAY[]::uuid[]) LOOP
    PERFORM relay_refresh_conversation_summary(reader);
  END LOOP;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_archive_index ON message_email_details;
CREATE TRIGGER email_archive_index AFTER INSERT OR UPDATE OF from_email,to_emails ON message_email_details
FOR EACH ROW EXECUTE FUNCTION relay_index_email_archive();

CREATE OR REPLACE FUNCTION relay_email_message_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM email_archive_addresses WHERE message_id=NEW.id) THEN
    PERFORM relay_refresh_email_readers(NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_archive_message_change ON messages;
CREATE TRIGGER email_archive_message_change AFTER UPDATE OF status,text_content,occurred_at ON messages
FOR EACH ROW EXECUTE FUNCTION relay_email_message_changed();

CREATE OR REPLACE FUNCTION relay_email_contact_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  FOR item IN SELECT id FROM conversations WHERE contact_id IN (
    CASE WHEN TG_OP<>'INSERT' THEN OLD.contact_id END,
    CASE WHEN TG_OP<>'DELETE' THEN NEW.contact_id END)
  LOOP PERFORM relay_refresh_conversation_summary(item.id); END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_archive_contact_change ON contact_emails;
CREATE TRIGGER email_archive_contact_change AFTER INSERT OR UPDATE OR DELETE ON contact_emails
FOR EACH ROW EXECUTE FUNCTION relay_email_contact_changed();

CREATE OR REPLACE FUNCTION relay_email_conversation_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM relay_refresh_conversation_summary(NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS email_archive_conversation_create ON conversations;
CREATE TRIGGER email_archive_conversation_create AFTER INSERT OR UPDATE OF contact_id,account_id ON conversations
FOR EACH ROW EXECUTE FUNCTION relay_email_conversation_created();

CREATE OR REPLACE FUNCTION relay_email_message_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE readers uuid[]; reader uuid;
BEGIN
  SELECT array_agg(DISTINCT c.id) INTO readers FROM email_archive_addresses a
    JOIN contact_emails e ON lower(btrim(e.email))=a.email
    JOIN conversations c ON c.contact_id=e.contact_id AND c.account_id=a.account_id
    WHERE a.message_id=OLD.id;
  -- 删除前移除地址索引，使摘要查询不再读到该邮件。
  DELETE FROM email_archive_addresses WHERE message_id=OLD.id;
  FOREACH reader IN ARRAY COALESCE(readers,ARRAY[]::uuid[]) LOOP
    PERFORM relay_refresh_conversation_summary(reader);
  END LOOP;
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS email_archive_message_delete ON messages;
CREATE TRIGGER email_archive_message_delete BEFORE DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION relay_email_message_deleted();

-- 删除某个访客或会话不能连带删除其他会话正在读取的邮件与附件。
CREATE OR REPLACE FUNCTION relay_preserve_email_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous text;
BEGIN
  previous=current_setting('relay.deleting_email_conversation',true);
  PERFORM set_config('relay.deleting_email_conversation',OLD.id::text,true);
  UPDATE messages m SET conversation_id=NULL WHERE m.conversation_id=OLD.id
    AND EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id);
  PERFORM set_config('relay.deleting_email_conversation',COALESCE(previous,''),true);
  RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS email_archive_preserve ON conversations;
CREATE TRIGGER email_archive_preserve BEFORE DELETE ON conversations
FOR EACH ROW EXECUTE FUNCTION relay_preserve_email_archive();

INSERT INTO email_archive_addresses(message_id,account_id,email)
SELECT d.message_id,m.account_id,lower(btrim(address)) FROM message_email_details d
JOIN messages m ON m.id=d.message_id CROSS JOIN LATERAL (
  SELECT d.from_email address WHERE m.direction='in'
  UNION SELECT jsonb_array_elements_text(d.to_emails) WHERE m.direction='out'
) addresses WHERE btrim(address)<>'' ON CONFLICT DO NOTHING;

-- 收件彻底解绑；发件保留来源会话作为审计元数据，读取仍只按邮箱。
UPDATE messages m SET conversation_id=NULL,sender_contact_id=NULL
WHERE m.direction='in' AND m.conversation_id IS NOT NULL
  AND EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id);
DO $$ DECLARE item record; BEGIN
  FOR item IN SELECT id FROM conversations ORDER BY id LOOP
    PERFORM relay_refresh_conversation_summary(item.id);
  END LOOP;
END $$;
