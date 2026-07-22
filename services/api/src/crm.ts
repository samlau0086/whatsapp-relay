export const STAGE_RANK:Record<string,number>={new:0,considering:1,qualified:2,lost:3,won:4};

export function preferredCustomerStage(target:string,source:string):string{
  return (STAGE_RANK[source]??0)>(STAGE_RANK[target]??0)?source:target;
}

export function canManageSharedRecord(role:string|undefined,ownerId:string|null,principalId:string):boolean{
  return ownerId===principalId||role==="admin"||role==="supervisor";
}

export type OrderSummaryItem={name:string;quantity:number;unitAmount:number};
export type OrderSummaryFee={name:string;amount:number};

export function calculateOrderTotal(items:OrderSummaryItem[],fees:OrderSummaryFee[]):number{return items.reduce((sum,item)=>sum+item.quantity*item.unitAmount,0)+fees.reduce((sum,fee)=>sum+fee.amount,0);}

export function formatOrderSummary(orderNumber:string|number,items:OrderSummaryItem[],fees:OrderSummaryFee[],currency:string,description?:string):string{
  const displayNumber=typeof orderNumber==="number"?String(orderNumber).padStart(6,"0"):orderNumber;
  const lines=[`Order #${displayNumber}`,"","Items:",...items.map((item,index)=>`${index+1}. ${item.name} x ${item.quantity} - ${currency} ${item.unitAmount.toFixed(2)} each - ${currency} ${(item.quantity*item.unitAmount).toFixed(2)}`)];
  if(fees.length)lines.push("","Additional fees:",...fees.map(fee=>`${fee.name} - ${currency} ${fee.amount.toFixed(2)}`));
  lines.push("",`Total: ${currency} ${calculateOrderTotal(items,fees).toFixed(2)}`);
  if(description)lines.push("",`Notes: ${description}`);
  return lines.join("\n");
}

type Queryable={query:(text:string,values?:unknown[])=>Promise<unknown>};

export async function ensureCrmTables(db:Queryable):Promise<void>{
  await db.query("ALTER TABLE conversations ADD COLUMN IF NOT EXISTS customer_stage text NOT NULL DEFAULT 'new'");
  await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='conversations_customer_stage_check') THEN ALTER TABLE conversations ADD CONSTRAINT conversations_customer_stage_check CHECK (customer_stage IN ('new','considering','qualified','won','lost')); END IF; END $$`);
  await db.query("ALTER TABLE notes ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()");
  await db.query(`CREATE TABLE IF NOT EXISTS reminders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,remind_at timestamptz NOT NULL,dismissed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(conversation_id,user_id))`);
  await db.query(`CREATE TABLE IF NOT EXISTS orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_number bigserial UNIQUE NOT NULL,client_order_id uuid UNIQUE NOT NULL,conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,created_by uuid REFERENCES users(id) ON DELETE SET NULL,product_name text,amount numeric(12,2) NOT NULL CHECK(amount>0),currency text NOT NULL CHECK(currency IN ('USD','CNY','EUR','GBP','JPY','HKD','SGD','AUD','CAD','AED')),description text,summary_message_id uuid REFERENCES messages(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`CREATE TABLE IF NOT EXISTS order_attachments (order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,media_id uuid NOT NULL REFERENCES media(id) ON DELETE RESTRICT,message_id uuid REFERENCES messages(id) ON DELETE SET NULL,ordinal smallint NOT NULL CHECK(ordinal BETWEEN 0 AND 2),PRIMARY KEY(order_id,media_id),UNIQUE(order_id,ordinal))`);
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS translate_on_send boolean NOT NULL DEFAULT false");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS target_language text");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS translated_text text");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS sent_at timestamptz");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS send_format text");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS rendered_media_id uuid REFERENCES media(id) ON DELETE SET NULL");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS deleted_at timestamptz");
  await db.query(`CREATE TABLE IF NOT EXISTS contact_addresses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,label text NOT NULL,recipient_name text,phone text,address text NOT NULL,created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS address_id uuid REFERENCES contact_addresses(id) ON DELETE SET NULL");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_address_snapshot jsonb");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS display_order_number text");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS sequence_date date");
  await db.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS daily_sequence integer");
  await db.query("UPDATE orders SET display_order_number=lpad(order_number::text,6,'0') WHERE display_order_number IS NULL");
  await db.query("ALTER TABLE orders ALTER COLUMN display_order_number SET NOT NULL");
  await db.query(`CREATE TABLE IF NOT EXISTS order_settings (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),number_template text NOT NULL DEFAULT '{YYYY}{MM}{DD}-{SEQ:3}',timezone text NOT NULL DEFAULT 'Asia/Shanghai',updated_by uuid REFERENCES users(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`ALTER TABLE order_settings ADD COLUMN IF NOT EXISTS text_template jsonb DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Order","bold":true,"blankAfter":true},{"id":"items","type":"itemList","label":"Items:","blankAfter":true},{"id":"fees","type":"feeList","label":"Additional fees:","blankAfter":true},{"id":"total","type":"total","label":"Total:","bold":true},{"id":"notes","type":"notes","label":"Notes:"}]}'::jsonb`);
  await db.query(`ALTER TABLE order_settings ADD COLUMN IF NOT EXISTS image_template jsonb DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Order","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"items","type":"itemList","label":"Items:","fontSize":"medium","textColor":"#20372D","backgroundColor":"#F6F9F7","align":"left","showProductImages":true,"imageSize":"medium"},{"id":"fees","type":"feeList","label":"Additional fees:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FAFCFB","align":"left"},{"id":"total","type":"total","label":"Total:","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"notes","type":"notes","label":"Notes:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FFFAF0","align":"left"}]}'::jsonb`);
  await db.query(`ALTER TABLE order_settings ALTER COLUMN text_template SET DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Order","bold":true,"blankAfter":true},{"id":"items","type":"itemList","label":"Items:","blankAfter":true},{"id":"fees","type":"feeList","label":"Additional fees:","blankAfter":true},{"id":"total","type":"total","label":"Total:","bold":true},{"id":"notes","type":"notes","label":"Notes:"}]}'::jsonb`);
  await db.query(`ALTER TABLE order_settings ALTER COLUMN image_template SET DEFAULT '{"version":1,"blocks":[{"id":"order-header","type":"orderHeader","label":"Order","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"items","type":"itemList","label":"Items:","fontSize":"medium","textColor":"#20372D","backgroundColor":"#F6F9F7","align":"left","showProductImages":true,"imageSize":"medium"},{"id":"fees","type":"feeList","label":"Additional fees:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FAFCFB","align":"left"},{"id":"total","type":"total","label":"Total:","fontSize":"large","textColor":"#FFFFFF","backgroundColor":"#153F2F","align":"left"},{"id":"notes","type":"notes","label":"Notes:","fontSize":"small","textColor":"#20372D","backgroundColor":"#FFFAF0","align":"left"}]}'::jsonb`);
  await db.query("INSERT INTO order_settings(singleton,text_template,image_template) VALUES(true,DEFAULT,DEFAULT) ON CONFLICT(singleton) DO NOTHING");
  await db.query("CREATE TABLE IF NOT EXISTS order_daily_sequences (sequence_date date PRIMARY KEY,last_value integer NOT NULL CHECK(last_value>0),updated_at timestamptz NOT NULL DEFAULT now())");
  await db.query("UPDATE orders SET status='queued',sent_at=COALESCE(sent_at,created_at) WHERE summary_message_id IS NOT NULL AND status='draft'");
  await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_check') THEN ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN ('draft','queued')); END IF; END $$`);
  await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_send_format_check') THEN ALTER TABLE orders ADD CONSTRAINT orders_send_format_check CHECK(send_format IS NULL OR send_format IN ('text','image')); END IF; END $$`);
  await db.query(`CREATE TABLE IF NOT EXISTS order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,position smallint NOT NULL,product_name text NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 9999),unit_amount numeric(12,2) NOT NULL CHECK(unit_amount>=0),image_media_id uuid REFERENCES media(id) ON DELETE RESTRICT,UNIQUE(order_id,position))`);
  await db.query(`CREATE TABLE IF NOT EXISTS order_fees (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,position smallint NOT NULL,name text NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>0),UNIQUE(order_id,position))`);
  await db.query(`CREATE TABLE IF NOT EXISTS products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),client_product_id uuid UNIQUE NOT NULL,name text NOT NULL,default_unit_amount numeric(12,2) NOT NULL CHECK(default_unit_amount>=0),currency text NOT NULL CHECK(currency IN ('USD','CNY','EUR','GBP','JPY','HKD','SGD','AUD','CAD','AED')),image_media_id uuid REFERENCES media(id) ON DELETE RESTRICT,created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz)`);
  await db.query("ALTER TABLE products ADD COLUMN IF NOT EXISTS sku text");
  await db.query("UPDATE products SET sku='SKU-'||upper(substr(replace(id::text,'-',''),1,12)) WHERE sku IS NULL OR btrim(sku)=''");
  await db.query("ALTER TABLE products ALTER COLUMN sku SET NOT NULL");
  await db.query(`CREATE TABLE IF NOT EXISTS product_price_tiers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,min_quantity integer NOT NULL CHECK(min_quantity BETWEEN 1 AND 999999),unit_amount numeric(12,2) NOT NULL CHECK(unit_amount>=0),UNIQUE(product_id,min_quantity))`);
  await db.query("INSERT INTO product_price_tiers(product_id,min_quantity,unit_amount) SELECT id,1,default_unit_amount FROM products ON CONFLICT(product_id,min_quantity) DO NOTHING");
  await db.query(`CREATE TABLE IF NOT EXISTS product_card_settings (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),template jsonb NOT NULL,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query(`INSERT INTO product_card_settings(singleton,template) VALUES(true,'{"version":1,"blocks":[{"id":"image","type":"productImage","imageSize":"large","imageFit":"cover","showPlaceholder":true,"backgroundColor":"#F2F6F4"},{"id":"name","type":"productName","label":"Product","fontSize":"large","textColor":"#153F2F","backgroundColor":"#FFFFFF","align":"left"},{"id":"sku","type":"sku","label":"SKU","fontSize":"small","textColor":"#607168","backgroundColor":"#FFFFFF","align":"left"},{"id":"prices","type":"priceTiers","label":"Pricing","fontSize":"medium","textColor":"#20372D","backgroundColor":"#F2F8F5","align":"left"},{"id":"tags","type":"tags","label":"","fontSize":"small","textColor":"#31644D","backgroundColor":"#EAF7F0","align":"left"}]}'::jsonb) ON CONFLICT(singleton) DO NOTHING`);
  await db.query(`CREATE TABLE IF NOT EXISTS product_labels (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,name text NOT NULL,color text NOT NULL DEFAULT '#E8EEF7')`);
  await db.query("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_id uuid REFERENCES products(id) ON DELETE SET NULL");
  await db.query("INSERT INTO order_items(order_id,position,product_name,quantity,unit_amount) SELECT id,0,COALESCE(product_name,'Manual item'),1,amount FROM orders WHERE NOT EXISTS(SELECT 1 FROM order_items WHERE order_items.order_id=orders.id)");
  await db.query("CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id,position)");
  await db.query("CREATE INDEX IF NOT EXISTS order_fees_order_idx ON order_fees(order_id,position)");
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS product_labels_product_name_unique ON product_labels(product_id,lower(name))");
  await db.query("CREATE INDEX IF NOT EXISTS products_active_updated_idx ON products(updated_at DESC,id) WHERE deleted_at IS NULL");
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS products_active_sku_unique ON products(lower(btrim(sku))) WHERE deleted_at IS NULL");
  await db.query("CREATE INDEX IF NOT EXISTS product_price_tiers_product_quantity_idx ON product_price_tiers(product_id,min_quantity)");
  await db.query("CREATE INDEX IF NOT EXISTS product_labels_name_idx ON product_labels(lower(name))");
  await db.query("CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items(product_id) WHERE product_id IS NOT NULL");
  await db.query("ALTER TABLE order_items ADD COLUMN IF NOT EXISTS product_sku text");
  await db.query("UPDATE order_items item SET product_sku=product.sku FROM products product WHERE item.product_id=product.id AND item.product_sku IS NULL");
  await db.query("CREATE INDEX IF NOT EXISTS reminders_user_due_idx ON reminders(user_id,remind_at) WHERE dismissed_at IS NULL");
  await db.query("CREATE INDEX IF NOT EXISTS orders_conversation_created_idx ON orders(conversation_id,created_at DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS orders_conversation_active_idx ON orders(conversation_id,created_at DESC) WHERE deleted_at IS NULL");
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS orders_display_number_unique ON orders(display_order_number)");
  await db.query("CREATE INDEX IF NOT EXISTS orders_management_created_idx ON orders(created_at DESC,id DESC) WHERE deleted_at IS NULL");
  await db.query("CREATE INDEX IF NOT EXISTS contact_addresses_contact_idx ON contact_addresses(contact_id,created_at DESC)");
  await db.query(`CREATE TABLE IF NOT EXISTS paypal_settings (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),enabled boolean NOT NULL DEFAULT false,environment text NOT NULL DEFAULT 'sandbox' CHECK(environment IN ('sandbox','live')),client_id_encrypted text,client_secret_encrypted text,updated_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
  await db.query("ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS reference_template text NOT NULL DEFAULT 'Order #{{orderNumber}}'");
  await db.query("ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS note_template text NOT NULL DEFAULT '{{orderNotes}}'");
  await db.query("ALTER TABLE paypal_settings ADD COLUMN IF NOT EXISTS item_name_template text NOT NULL DEFAULT '{{productName}}'");
  await db.query("INSERT INTO paypal_settings(singleton) VALUES(true) ON CONFLICT(singleton) DO NOTHING");
  await db.query(`CREATE TABLE IF NOT EXISTS order_payment_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,provider text NOT NULL DEFAULT 'paypal' CHECK(provider='paypal'),environment text NOT NULL CHECK(environment IN ('sandbox','live')),provider_request_id text,payment_url text,status text NOT NULL DEFAULT 'CREATING',amount numeric(12,2) NOT NULL CHECK(amount>0),currency text NOT NULL,is_current boolean NOT NULL DEFAULT true,created_by uuid REFERENCES users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),last_synced_at timestamptz,cancelled_at timestamptz,failure_reason text)`);
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS order_payment_requests_current_unique ON order_payment_requests(order_id) WHERE is_current");
  await db.query("CREATE UNIQUE INDEX IF NOT EXISTS order_payment_requests_provider_id_unique ON order_payment_requests(environment,provider_request_id) WHERE provider_request_id IS NOT NULL");
  await db.query("CREATE INDEX IF NOT EXISTS order_payment_requests_order_created_idx ON order_payment_requests(order_id,created_at DESC)");
}
