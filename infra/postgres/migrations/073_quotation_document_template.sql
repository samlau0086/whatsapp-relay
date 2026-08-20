ALTER TABLE order_settings
  ADD COLUMN IF NOT EXISTS qt_template jsonb;

UPDATE order_settings
SET qt_template=COALESCE(
  qt_template,
  jsonb_set(
    jsonb_set(COALESCE(pdf_template,'{}'::jsonb), '{blocks,0,label}', '"Quotation"'::jsonb),
    '{blocks,0,statusLabels}',
    '{"quotation":"Quotation","pending_confirmation":"Quotation","pending_payment":"Quotation","paid":"Quotation","processing":"Quotation","shipped":"Quotation","completed":"Quotation","cancelled":"Quotation"}'::jsonb
  )
);

ALTER TABLE order_settings
  ALTER COLUMN qt_template SET DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Quotation","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"items","type":"itemList","label":"Items:","itemTemplate":"{{index}}. {{title}} x {{quantity}} - {{price}} each - {{subtotal}}","fontSize":"medium","textColor":"#20372D","backgroundColor":"#F6F9F7","align":"left","showProductImages":true,"imageSize":"medium"},{"id":"total","type":"total","label":"Total:","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"payment-summary","type":"paymentSummary","label":"Payment:","fontSize":"medium","textColor":"#20372D","backgroundColor":"#EEF6F2","align":"left"}]}'::jsonb,
  ALTER COLUMN qt_template SET NOT NULL;
