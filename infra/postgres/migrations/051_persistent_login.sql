ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS persistent boolean NOT NULL DEFAULT false;
