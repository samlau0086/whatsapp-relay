ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_id uuid;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_text text;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_kind message_kind;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_direction message_direction;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_message_status delivery_status;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary_updated_at timestamptz;

CREATE OR REPLACE FUNCTION relay_refresh_conversation_summary(target_conversation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE latest messages%ROWTYPE;
BEGIN
  SELECT * INTO latest FROM messages
  WHERE conversation_id=target_conversation_id
  ORDER BY occurred_at DESC,id DESC LIMIT 1;
  UPDATE conversations SET
    last_message_id=latest.id,
    last_message_text=latest.text_content,
    last_message_kind=latest.kind,
    last_message_direction=latest.direction,
    last_message_status=latest.status,
    last_message_at=latest.occurred_at,
    summary_updated_at=now()
  WHERE id=target_conversation_id;
END $$;

CREATE OR REPLACE FUNCTION relay_refresh_summaries_after_message_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  FOR item IN SELECT DISTINCT conversation_id FROM new_messages LOOP
    PERFORM relay_refresh_conversation_summary(item.conversation_id);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION relay_refresh_summaries_after_message_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  FOR item IN SELECT DISTINCT conversation_id FROM old_messages LOOP
    PERFORM relay_refresh_conversation_summary(item.conversation_id);
  END LOOP;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION relay_refresh_summaries_after_message_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conversation_id FROM new_messages
    UNION
    SELECT conversation_id FROM old_messages
  LOOP
    PERFORM relay_refresh_conversation_summary(item.conversation_id);
  END LOOP;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS messages_summary_insert ON messages;
CREATE TRIGGER messages_summary_insert AFTER INSERT ON messages
REFERENCING NEW TABLE AS new_messages FOR EACH STATEMENT
EXECUTE FUNCTION relay_refresh_summaries_after_message_insert();

DROP TRIGGER IF EXISTS messages_summary_delete ON messages;
CREATE TRIGGER messages_summary_delete AFTER DELETE ON messages
REFERENCING OLD TABLE AS old_messages FOR EACH STATEMENT
EXECUTE FUNCTION relay_refresh_summaries_after_message_delete();

DROP TRIGGER IF EXISTS messages_summary_update ON messages;
CREATE TRIGGER messages_summary_update AFTER UPDATE ON messages
REFERENCING OLD TABLE AS old_messages NEW TABLE AS new_messages FOR EACH STATEMENT
EXECUTE FUNCTION relay_refresh_summaries_after_message_update();

CREATE OR REPLACE FUNCTION relay_publish_conversation_change(target_conversation_id uuid,target_account_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('relay.suppress_conversation_notify',true),'off')<>'on' THEN
    PERFORM pg_notify('relay_conversation_changes',json_build_object('conversationId',target_conversation_id,'accountId',target_account_id)::text);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION relay_notify_conversation_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM relay_publish_conversation_change(OLD.id,OLD.account_id);
    RETURN OLD;
  END IF;
  PERFORM relay_publish_conversation_change(NEW.id,NEW.account_id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS conversations_change_notify ON conversations;
CREATE TRIGGER conversations_change_notify AFTER INSERT OR UPDATE OR DELETE ON conversations
FOR EACH ROW EXECUTE FUNCTION relay_notify_conversation_row();

CREATE OR REPLACE FUNCTION relay_notify_contact_conversations() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  FOR item IN SELECT id,account_id FROM conversations WHERE contact_id=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END LOOP
    PERFORM relay_publish_conversation_change(item.id,item.account_id);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS contacts_conversation_notify ON contacts;
CREATE TRIGGER contacts_conversation_notify AFTER UPDATE OR DELETE ON contacts
FOR EACH ROW EXECUTE FUNCTION relay_notify_contact_conversations();

CREATE OR REPLACE FUNCTION relay_notify_related_conversation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target_id uuid; target_account uuid;
BEGIN
  target_id=CASE WHEN TG_OP='DELETE' THEN OLD.conversation_id ELSE NEW.conversation_id END;
  SELECT account_id INTO target_account FROM conversations WHERE id=target_id;
  IF target_account IS NOT NULL THEN PERFORM relay_publish_conversation_change(target_id,target_account); END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reminders_conversation_notify ON reminders;
CREATE TRIGGER reminders_conversation_notify AFTER INSERT OR UPDATE OR DELETE ON reminders
FOR EACH ROW EXECUTE FUNCTION relay_notify_related_conversation();
DROP TRIGGER IF EXISTS conversation_tags_change_notify ON conversation_tags;
CREATE TRIGGER conversation_tags_change_notify AFTER INSERT OR UPDATE OR DELETE ON conversation_tags
FOR EACH ROW EXECUTE FUNCTION relay_notify_related_conversation();

CREATE OR REPLACE FUNCTION relay_notify_tag_conversations() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT c.id,c.account_id FROM conversation_tags ct
    JOIN conversations c ON c.id=ct.conversation_id
    WHERE ct.tag_id=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END
  LOOP
    PERFORM relay_publish_conversation_change(item.id,item.account_id);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS tags_conversation_notify ON tags;
CREATE TRIGGER tags_conversation_notify AFTER UPDATE OR DELETE ON tags
FOR EACH ROW EXECUTE FUNCTION relay_notify_tag_conversations();
