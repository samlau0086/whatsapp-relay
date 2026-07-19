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

export function formatOrderSummary(orderNumber:number,items:OrderSummaryItem[],fees:OrderSummaryFee[],currency:string,description?:string):string{
  const lines=[`Order #${String(orderNumber).padStart(6,"0")}`,"","Items:",...items.map((item,index)=>`${index+1}. ${item.name} x ${item.quantity} - ${currency} ${item.unitAmount.toFixed(2)} each - ${currency} ${(item.quantity*item.unitAmount).toFixed(2)}`)];
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
  await db.query("UPDATE orders SET status='queued',sent_at=COALESCE(sent_at,created_at) WHERE summary_message_id IS NOT NULL AND status='draft'");
  await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_status_check') THEN ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK(status IN ('draft','queued')); END IF; END $$`);
  await db.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='orders_send_format_check') THEN ALTER TABLE orders ADD CONSTRAINT orders_send_format_check CHECK(send_format IS NULL OR send_format IN ('text','image')); END IF; END $$`);
  await db.query(`CREATE TABLE IF NOT EXISTS order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,position smallint NOT NULL,product_name text NOT NULL,quantity integer NOT NULL CHECK(quantity BETWEEN 1 AND 9999),unit_amount numeric(12,2) NOT NULL CHECK(unit_amount>=0),image_media_id uuid REFERENCES media(id) ON DELETE RESTRICT,UNIQUE(order_id,position))`);
  await db.query(`CREATE TABLE IF NOT EXISTS order_fees (id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,position smallint NOT NULL,name text NOT NULL,amount numeric(12,2) NOT NULL CHECK(amount>0),UNIQUE(order_id,position))`);
  await db.query("INSERT INTO order_items(order_id,position,product_name,quantity,unit_amount) SELECT id,0,COALESCE(product_name,'Manual item'),1,amount FROM orders WHERE NOT EXISTS(SELECT 1 FROM order_items WHERE order_items.order_id=orders.id)");
  await db.query("CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id,position)");
  await db.query("CREATE INDEX IF NOT EXISTS order_fees_order_idx ON order_fees(order_id,position)");
  await db.query("CREATE INDEX IF NOT EXISTS reminders_user_due_idx ON reminders(user_id,remind_at) WHERE dismissed_at IS NULL");
  await db.query("CREATE INDEX IF NOT EXISTS orders_conversation_created_idx ON orders(conversation_id,created_at DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS orders_conversation_active_idx ON orders(conversation_id,created_at DESC) WHERE deleted_at IS NULL");
}
