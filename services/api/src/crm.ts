export const STAGE_RANK:Record<string,number>={new:0,considering:1,qualified:2,lost:3,won:4};

export function preferredCustomerStage(target:string,source:string):string{
  return (STAGE_RANK[source]??0)>(STAGE_RANK[target]??0)?source:target;
}

export function canManageSharedRecord(role:string|undefined,ownerId:string|null,principalId:string):boolean{
  return ownerId===principalId||role==="admin"||role==="supervisor";
}

export function formatOrderSummary(orderNumber:number,productName:string|undefined,amount:number,currency:string,description?:string):string{
  const lines=[`订单 #${String(orderNumber).padStart(6,"0")}`,`商品：${productName||"手工订单"}`,`金额：${currency} ${amount.toFixed(2)}`];
  if(description)lines.push(`说明：${description}`);
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
  await db.query("CREATE INDEX IF NOT EXISTS reminders_user_due_idx ON reminders(user_id,remind_at) WHERE dismissed_at IS NULL");
  await db.query("CREATE INDEX IF NOT EXISTS orders_conversation_created_idx ON orders(conversation_id,created_at DESC)");
}
