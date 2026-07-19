ALTER TABLE translation_provider_settings
  ADD COLUMN IF NOT EXISTS transcription_model text NOT NULL DEFAULT 'gpt-4o-mini-transcribe';

CREATE TABLE IF NOT EXISTS message_transcriptions (
  message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  transcript_text text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
