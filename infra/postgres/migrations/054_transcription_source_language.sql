ALTER TABLE message_transcriptions
  ADD COLUMN IF NOT EXISTS source_language text;
