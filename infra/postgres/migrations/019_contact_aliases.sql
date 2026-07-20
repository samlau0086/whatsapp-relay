-- User-managed aliases are stable and must not be overwritten by WhatsApp sync.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS alias text;

