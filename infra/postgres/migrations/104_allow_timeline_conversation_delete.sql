-- 已合并时间线会话允许删除；账号转移仍由原触发器阻止。
CREATE OR REPLACE FUNCTION relay_guard_timeline_merge_member() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RETURN OLD;
  END IF;
  IF NEW.account_id IS NOT DISTINCT FROM OLD.account_id THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM conversation_timeline_merges WHERE source_id=OLD.id OR target_id=OLD.id) THEN
    RAISE EXCEPTION 'conversation_timeline_merge_member' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
