ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS reference_template text NOT NULL DEFAULT 'Order #{{orderNumber}}';
ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS note_template text NOT NULL DEFAULT '{{orderNotes}}';
ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS item_name_template text NOT NULL DEFAULT '{{productName}}';
