ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS translation_source_text text;

COMMENT ON COLUMN messages.translation_source_text IS
  'Agent-visible source text for an outgoing translated message; never included in the WhatsApp outbound payload.';
