ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS preferred_language varchar(35);

COMMENT ON COLUMN contacts.preferred_language IS
  'Contact preferred language as a normalized BCP 47 language tag.';
