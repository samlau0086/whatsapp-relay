CREATE TABLE IF NOT EXISTS conversation_timeline_merges (
  source_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE RESTRICT,
  target_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  merged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(source_id<>target_id)
);
CREATE INDEX IF NOT EXISTS conversation_timeline_merges_target_idx ON conversation_timeline_merges(target_id);

CREATE OR REPLACE FUNCTION relay_guard_timeline_merge_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM conversation_timeline_merges WHERE source_id=OLD.id OR target_id=OLD.id) THEN
    RAISE EXCEPTION 'conversation_timeline_merge_member' USING ERRCODE='23514';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

DROP TRIGGER IF EXISTS conversation_timeline_merge_member_guard ON conversations;
CREATE TRIGGER conversation_timeline_merge_member_guard
BEFORE DELETE OR UPDATE OF account_id ON conversations
FOR EACH ROW EXECUTE FUNCTION relay_guard_timeline_merge_member();

CREATE OR REPLACE FUNCTION relay_conversation_members(conversation uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH root AS (SELECT COALESCE((SELECT target_id FROM conversation_timeline_merges WHERE source_id=conversation),conversation) id)
  SELECT id FROM root UNION ALL
  SELECT source_id FROM conversation_timeline_merges JOIN root ON target_id=root.id;
$$;

-- 只合并坐席时间线，不修改消息归属或公开访客的读取边界。
CREATE OR REPLACE FUNCTION relay_refresh_conversation_summary(target_conversation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE latest messages%ROWTYPE;
BEGIN
  SELECT * INTO latest FROM messages
  WHERE conversation_id=target_conversation_id OR conversation_id IN (SELECT source_id FROM conversation_timeline_merges WHERE target_id=target_conversation_id)
  ORDER BY occurred_at DESC,id DESC LIMIT 1;
  UPDATE conversations SET
    last_message_id=latest.id,last_message_text=latest.text_content,
    last_message_kind=latest.kind,last_message_direction=latest.direction,
    last_message_status=latest.status,last_message_at=latest.occurred_at,
    last_message_sender_provider_user_id=latest.sender_provider_user_id,
    last_message_sender_name=latest.sender_display_name,
    summary_updated_at=now()
  WHERE id=target_conversation_id;
END $$;

CREATE OR REPLACE FUNCTION relay_notify_conversation_row() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE root_id uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM relay_publish_conversation_change(OLD.id,OLD.account_id);
    RETURN OLD;
  END IF;
  SELECT target_id INTO root_id FROM conversation_timeline_merges WHERE source_id=NEW.id;
  IF root_id IS NOT NULL THEN
    PERFORM relay_refresh_conversation_summary(root_id);
    IF TG_OP='UPDATE' AND NEW.unread_count>OLD.unread_count THEN
      UPDATE conversations SET status='open',closed_at=NULL WHERE id=root_id AND status='closed';
    END IF;
  END IF;
  PERFORM relay_publish_conversation_change(NEW.id,NEW.account_id);
  RETURN NEW;
END $$;
