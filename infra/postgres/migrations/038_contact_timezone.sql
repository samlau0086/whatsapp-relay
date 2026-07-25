ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS timezone text;

COMMENT ON COLUMN contacts.timezone IS
  'Optional contact-specific IANA time zone. When null, infer a representative time zone from phone_e164 country calling code.';
