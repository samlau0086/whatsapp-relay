ALTER TABLE notes ADD COLUMN IF NOT EXISTS note_type text NOT NULL DEFAULT 'normal';
ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_note_type_check;
ALTER TABLE notes ADD CONSTRAINT notes_note_type_check CHECK(note_type IN ('order','normal'));
