ALTER TABLE shipping_template_rules
  ADD COLUMN IF NOT EXISTS destination_country_code text,
  ADD COLUMN IF NOT EXISTS destination_province text;

UPDATE shipping_template_rules
SET destination_country_code=upper(btrim(destination_country_code)),
    destination_province=NULLIF(btrim(destination_province),'');

ALTER TABLE shipping_template_rules
  DROP CONSTRAINT IF EXISTS shipping_template_rules_destination_check;
ALTER TABLE shipping_template_rules
  ADD CONSTRAINT shipping_template_rules_destination_check CHECK (
    (destination_country_code IS NULL AND destination_province IS NULL)
    OR (
      destination_country_code ~ '^[A-Z]{2}$'
      AND (destination_province IS NULL OR length(destination_province) <= 100)
    )
  );

DROP INDEX IF EXISTS shipping_template_rules_class_unique;
DROP INDEX IF EXISTS shipping_template_rules_default_unique;
CREATE UNIQUE INDEX IF NOT EXISTS shipping_template_rules_destination_unique
  ON shipping_template_rules(
    template_id,
    COALESCE(shipping_class_id,'00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(destination_country_code,''),
    COALESCE(lower(btrim(destination_province)),'')
  );

ALTER TABLE contact_addresses
  ADD COLUMN IF NOT EXISTS country_code text,
  ADD COLUMN IF NOT EXISTS province text;

UPDATE contact_addresses
SET country_code=upper(btrim(country_code)),
    province=NULLIF(btrim(province),'');

ALTER TABLE contact_addresses
  DROP CONSTRAINT IF EXISTS contact_addresses_destination_check;
ALTER TABLE contact_addresses
  ADD CONSTRAINT contact_addresses_destination_check CHECK (
    (country_code IS NULL AND province IS NULL)
    OR (
      country_code ~ '^[A-Z]{2}$'
      AND (province IS NULL OR length(province) <= 100)
    )
  );
