ALTER TABLE status_posts
  ADD COLUMN IF NOT EXISTS translation_source_text text,
  ADD COLUMN IF NOT EXISTS translation_target_language varchar(35);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='status_posts_translation_pair_check'
      AND conrelid='status_posts'::regclass
  ) THEN
    ALTER TABLE status_posts
      ADD CONSTRAINT status_posts_translation_pair_check
      CHECK (
        (translation_source_text IS NULL AND translation_target_language IS NULL)
        OR (translation_source_text IS NOT NULL AND translation_target_language IS NOT NULL)
      );
  END IF;
END $$;
