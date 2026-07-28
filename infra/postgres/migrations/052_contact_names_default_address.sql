ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS first_name text,
  ADD COLUMN IF NOT EXISTS middle_name text,
  ADD COLUMN IF NOT EXISTS last_name text;

ALTER TABLE contact_addresses
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

UPDATE contact_addresses address
SET is_default=true
WHERE address.id=(
  SELECT candidate.id
  FROM contact_addresses candidate
  WHERE candidate.contact_id=address.contact_id
  ORDER BY candidate.is_default DESC,candidate.created_at,candidate.id
  LIMIT 1
)
AND NOT EXISTS(
  SELECT 1
  FROM contact_addresses current_default
  WHERE current_default.contact_id=address.contact_id
    AND current_default.is_default
);

WITH ranked AS (
  SELECT id,row_number() OVER(
    PARTITION BY contact_id
    ORDER BY updated_at DESC,id
  ) position
  FROM contact_addresses
  WHERE is_default
)
UPDATE contact_addresses address
SET is_default=false
FROM ranked
WHERE address.id=ranked.id
  AND ranked.position>1;

CREATE UNIQUE INDEX IF NOT EXISTS contact_addresses_one_default_unique
  ON contact_addresses(contact_id) WHERE is_default;
