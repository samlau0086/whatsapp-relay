ALTER TABLE message_translations
  ADD COLUMN IF NOT EXISTS source_language text;
