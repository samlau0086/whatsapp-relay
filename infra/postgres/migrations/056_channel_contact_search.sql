CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Keep this expression identical to the unified inbox contact-search predicate.
-- The former index did not include provider_user_id and could no longer serve
-- Messenger-aware searches, forcing a sequential scan across all contacts.
CREATE INDEX IF NOT EXISTS contacts_channel_search_trgm_idx ON contacts USING gin
  ((COALESCE(alias,'') || ' ' || COALESCE(display_name,'') || ' ' ||
    COALESCE(phone_e164,'') || ' ' || provider_user_id) gin_trgm_ops);

CREATE INDEX IF NOT EXISTS conversations_last_message_text_trgm_idx ON conversations USING gin
  (last_message_text gin_trgm_ops);

DROP INDEX IF EXISTS contacts_conversation_search_trgm_idx;
