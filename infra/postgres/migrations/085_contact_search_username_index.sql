DO $$
DECLARE
  index_definition text;
BEGIN
  SELECT pg_get_indexdef(indexrelid)
    INTO index_definition
  FROM pg_index
  WHERE indexrelid = 'contacts_channel_search_trgm_idx'::regclass;

  IF index_definition IS NOT NULL AND position('whatsapp_username' IN index_definition) = 0 THEN
    DROP INDEX contacts_channel_search_trgm_idx;
  END IF;
EXCEPTION WHEN undefined_table THEN
  NULL;
END $$;

CREATE INDEX IF NOT EXISTS contacts_channel_search_trgm_idx ON contacts USING gin
  ((COALESCE(alias,'') || ' ' || COALESCE(display_name,'') || ' ' ||
    COALESCE(phone_e164,'') || ' ' || COALESCE(provider_user_id,'') || ' ' ||
    COALESCE(whatsapp_username,'')) gin_trgm_ops);
