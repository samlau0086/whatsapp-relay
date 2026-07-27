ALTER TABLE order_settings
  ADD COLUMN IF NOT EXISTS pdf_template jsonb;

UPDATE order_settings
SET pdf_template=COALESCE(pdf_template,image_template)
WHERE pdf_template IS NULL;

ALTER TABLE order_settings
  ALTER COLUMN pdf_template SET DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Order","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"items","type":"itemList","label":"Items:","fontSize":"medium","textColor":"#20372D","backgroundColor":"#F6F9F7","align":"left","showProductImages":true,"imageSize":"medium"},{"id":"fees","type":"feeList","label":"Additional fees:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FAFCFB","align":"left"},{"id":"total","type":"total","label":"Total:","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"payment-summary","type":"paymentSummary","label":"Payment:","fontSize":"medium","textColor":"#20372D","backgroundColor":"#EEF6F2","align":"left"},{"id":"notes","type":"notes","label":"Notes:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FFFAF0","align":"left"}]}'::jsonb,
  ALTER COLUMN pdf_template SET NOT NULL;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_send_format_check;
ALTER TABLE orders ADD CONSTRAINT orders_send_format_check
  CHECK(send_format IS NULL OR send_format IN ('text','image','pdf'));

ALTER TABLE email_messages DROP CONSTRAINT IF EXISTS email_messages_content_type_check;
ALTER TABLE email_messages ADD CONSTRAINT email_messages_content_type_check
  CHECK(content_type IN ('order_text','order_image','order_pdf','product_cards'));
