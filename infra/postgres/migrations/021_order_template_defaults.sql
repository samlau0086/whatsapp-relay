-- Recovery migration: 020 made these columns NOT NULL without defaults, which
-- prevents both current and rollback API releases from creating the singleton.
ALTER TABLE order_settings
  ALTER COLUMN text_template SET DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Order","bold":true,"blankAfter":true},{"id":"items","type":"itemList","label":"Items:","blankAfter":true},{"id":"fees","type":"feeList","label":"Additional fees:","blankAfter":true},{"id":"total","type":"total","label":"Total:","bold":true},{"id":"notes","type":"notes","label":"Notes:"}]}'::jsonb,
  ALTER COLUMN image_template SET DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Order","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"items","type":"itemList","label":"Items:","fontSize":"medium","textColor":"#20372D","backgroundColor":"#F6F9F7","align":"left","showProductImages":true,"imageSize":"medium"},{"id":"fees","type":"feeList","label":"Additional fees:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FAFCFB","align":"left"},{"id":"total","type":"total","label":"Total:","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"notes","type":"notes","label":"Notes:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FFFAF0","align":"left"}]}'::jsonb;

INSERT INTO order_settings(singleton)
VALUES(true)
ON CONFLICT(singleton) DO UPDATE SET
  text_template=COALESCE(order_settings.text_template,EXCLUDED.text_template),
  image_template=COALESCE(order_settings.image_template,EXCLUDED.image_template);

ALTER TABLE order_settings
  ALTER COLUMN text_template SET NOT NULL,
  ALTER COLUMN image_template SET NOT NULL;
