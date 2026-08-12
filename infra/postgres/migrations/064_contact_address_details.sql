ALTER TABLE contact_addresses
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS street_line_1 text,
  ADD COLUMN IF NOT EXISTS street_line_2 text,
  ADD COLUMN IF NOT EXISTS postal_code text;

UPDATE contact_addresses
SET street_line_1=address
WHERE street_line_1 IS NULL OR btrim(street_line_1)='';
