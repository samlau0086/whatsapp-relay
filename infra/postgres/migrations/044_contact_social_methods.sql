ALTER TABLE contact_methods
  DROP CONSTRAINT IF EXISTS contact_methods_type_check;

ALTER TABLE contact_methods
  ADD CONSTRAINT contact_methods_type_check
  CHECK(type IN (
    'phone',
    'wechat',
    'telegram',
    'line',
    'website',
    'facebook',
    'x',
    'linkedin',
    'instagram',
    'other'
  ));
