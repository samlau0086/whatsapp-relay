CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS contacts_alias_trgm_idx ON contacts USING gin (alias gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_display_name_trgm_idx ON contacts USING gin (display_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_phone_e164_trgm_idx ON contacts USING gin (phone_e164 gin_trgm_ops);
CREATE INDEX IF NOT EXISTS contacts_conversation_search_trgm_idx ON contacts USING gin
  ((COALESCE(alias,'') || ' ' || COALESCE(display_name,'') || ' ' || phone_e164) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS messages_text_content_trgm_idx ON messages USING gin (text_content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS conversations_sort_idx ON conversations((COALESCE(last_message_at,created_at)) DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_account_sort_idx ON conversations(account_id,last_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_status_sort_idx ON conversations(status,last_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_assignee_sort_idx ON conversations(assigned_user_id,last_message_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS conversations_favorite_sort_idx ON conversations(last_message_at DESC,id DESC) WHERE favorite;
