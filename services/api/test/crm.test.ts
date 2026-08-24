import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateOrderTotal, canManageSharedRecord, formatOrderSummary, preferredCustomerStage, primaryContactEmail } from "../src/crm.js";

test("shared notes remain owner-managed with supervisor override",()=>{
  assert.equal(canManageSharedRecord("agent","user-1","user-1"),true);
  assert.equal(canManageSharedRecord("agent","user-1","user-2"),false);
  assert.equal(canManageSharedRecord("supervisor","user-1","user-2"),true);
  assert.equal(canManageSharedRecord("admin",null,"user-2"),true);
});

test("default contact email resolves only the primary address",()=>{
  assert.equal(primaryContactEmail([{email:"secondary@example.com"},{email:"primary@example.com",isPrimary:true}]),"primary@example.com");
  assert.equal(primaryContactEmail([]),null);
});

test("contact merges retain the furthest customer stage",()=>{
  assert.equal(preferredCustomerStage("new","qualified"),"qualified");
  assert.equal(preferredCustomerStage("won","lost"),"won");
});

test("order summaries are stable and customer-readable",()=>{
  const items=[{name:"Perfume",quantity:2,unitAmount:49.75},{name:"Gift box",quantity:1,unitAmount:8}];
  const fees=[{name:"Shipping",amount:6.5}];
  assert.equal(calculateOrderTotal(items,fees),114);
  const summary=formatOrderSummary(27,items,fees,"USD","Handle with care");
  assert.match(summary,/Order #000027/);
  assert.match(summary,/1\. Perfume x 2 - USD 49\.75 each - USD 99\.50/);
  assert.match(summary,/Additional fees:\nShipping - USD 6\.50/);
  assert.match(summary,/Total: USD 114\.00/);
  assert.match(summary,/Notes: Handle with care/);
});

test("order sending and deletion ship with an idempotent database upgrade",async()=>{
  const [server,migration]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/011_order_send_formats.sql",import.meta.url),"utf8"),
  ]);
  assert.match(server,/orderSendSchema\.safeParse/);
  assert.match(server,/orderUpdateSchema\.safeParse/);
  assert.match(server,/renderTemplateOrderImage/);
  assert.match(server,/clientSendId/);
  assert.match(server,/shouldTranslate=parsed\.data\.translate/);
  assert.match(server,/targetLanguage=parsed\.data\.targetLanguage/);
  assert.match(server,/translated:shouldTranslate/);
  assert.match(server,/order\.update/);
  assert.doesNotMatch(server,/if\(order\.status!=="draft"\)return reply\.code\(202\)/);
  assert.match(server,/app\.delete\("\/api\/v1\/conversations\/:conversationId\/orders\/:orderId"/);
  assert.match(server,/o\.deleted_at IS NULL/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS send_format/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS rendered_media_id/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS deleted_at/);
});

test("order tracking schema is initialized before tracking routes are available",async()=>{
  const [crm,server,migration,migrator]=await Promise.all([
    readFile(new URL("../src/crm.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/074_order_tracking.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  for(const column of ["tracking_carrier","tracking_number","tracking_url","paypal_tracking_synced_at"]){
    assert.match(crm,new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
    assert.match(migration,new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(migrator,/074_order_tracking\.sql/);
  assert.match(server,/tracking_save_failed/);
  assert.match(server,/tracking_schema_unavailable/);
  assert.match(server,/trackingFailureMessage/);
  assert.match(server,/await ensureOrderTrackingColumns\(\)/);
  assert.match(server,/ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_carrier text/);
  assert.match(server,/ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at timestamptz/);
  assert.match(crm,/ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at timestamptz/);
});

test("order template defaults recover an empty settings singleton after migration",async()=>{
  const [crm,migration,migrator]=await Promise.all([
    readFile(new URL("../src/crm.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/021_order_template_defaults.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ALTER COLUMN text_template SET DEFAULT/);
  assert.match(migration,/ALTER COLUMN image_template SET DEFAULT/);
  assert.match(migration,/INSERT INTO order_settings\(singleton\)/);
  assert.match(crm,/VALUES\(true,DEFAULT,DEFAULT\)/);
  assert.match(migrator,/021_order_template_defaults\.sql/);
});

test("customer addresses are reusable while orders retain an address snapshot",async()=>{
  const [server,migration]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/015_customer_addresses.sql",import.meta.url),"utf8"),
  ]);
  assert.match(server,/contact_addresses WHERE contact_id/);
  assert.match(server,/resolveOrderAddress/);
  assert.match(server,/shipping_address_snapshot/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS contact_addresses/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS address_id/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS shipping_address_snapshot jsonb/);
});

test("structured contact names and one default shipping address are migrated",async()=>{
  const [migration,migrator,server,inbox]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/052_contact_names_default_address.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS first_name text/);
  assert.match(migration,/contact_addresses_one_default_unique/);
  assert.match(migrator,/052_contact_names_default_address\.sql/);
  assert.match(server,/firstName:String\(row\.first_name/);
  assert.match(inbox,/next\.find\(item=>item\.isDefault\)/);
});

test("contact business and location fields are migrated, searchable, and exposed",async()=>{
  const [migration,migrator,server,inbox]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/061_contact_business_location.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  for(const column of ["company_name","job_title","country","province","city"])assert.match(migration,new RegExp(`ADD COLUMN IF NOT EXISTS ${column} text`));
  assert.match(migrator,/061_contact_business_location\.sql/);
  assert.match(server,/companyName:String\(row\.company_name/);
  assert.match(server,/co\.company_name ILIKE/);
  assert.match(server,/co\.city ILIKE/);
  assert.match(inbox,/<label>公司名<input value=\{companyName\}/);
  assert.match(inbox,/<dt>城市<\/dt><dd>\{profile\.city/);
});

test("contact aliases stay independent from synchronized WhatsApp names",async()=>{
  const [server,hub,migration,migrator]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/019_contact_aliases.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS alias text/);
  assert.match(migrator,/019_contact_aliases\.sql/);
  assert.match(server,/contact\.alias\.update/);
  assert.match(server,/COALESCE\(NULLIF\(co\.alias,''\),co\.display_name,co\.phone_e164,co\.provider_user_id\)/);
  assert.match(hub,/const bestAlias=/);
  assert.match(hub,/INSERT INTO contact_emails/);
  assert.match(hub,/INSERT INTO contact_methods/);
  assert.match(hub,/UPDATE contact_addresses SET contact_id/);
  assert.doesNotMatch(hub,/UPDATE contacts SET[^\n]*alias=COALESCE\(NULLIF\(EXCLUDED\.display_name/);
});

test("outbound message echoes cannot replace synchronized contact names",async()=>{
  const [hub,worker]=await Promise.all([
    readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../apps/agent/src/account-worker.ts",import.meta.url),"utf8"),
  ]);
  assert.match(worker,/const remotePushName\s*=\s*item\.key\.fromMe\s*\?\s*undefined\s*:\s*item\.pushName\s*\?\?\s*undefined/);
  assert.match(worker,/senderName:\s*remotePushName/);
  assert.match(hub,/const remoteDisplayName=payload\.direction==="in"\?String\(payload\.senderName\?\?""\)\.trim\(\):""/);
  assert.match(hub,/displayName:remoteDisplayName/);
  assert.match(hub,/display_name=COALESCE\(NULLIF\(\$5,''\),contacts\.display_name\)/);
  assert.match(hub,/remoteDisplayName\|\|phone\|\|chatJid\.split\("@"\)\[0\],remoteDisplayName/);
  assert.match(hub,/const usableName=\(value:unknown\)=>\{const name=String\(value\?\?""\)\.trim\(\);return name&&!\/\^\\\+\?\\d\+\$\/\.test\(name\)\?name:null;\}/);
  assert.match(hub,/const suppliedName=usableName\(payload\.displayName\)/);
  assert.match(hub,/found\.rows\.map\(row=>usableName\(row\.display_name\)\)\.find/);
});

test("conversation deletion is privileged and blocks unsafe cascading deletes",async()=>{
  const [server,inbox]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(server,/app\.delete\("\/api\/v1\/conversations\/:id"/);
  assert.match(server,/\["admin","supervisor"\]\.includes/);
  assert.match(server,/payment_request_exists/);
  assert.match(server,/outbound_pending/);
  assert.match(server,/conversation\.delete/);
  assert.match(inbox,/永久删除会话/);
  assert.match(inbox,/method:"DELETE"/);
});

test("contact profile migration and routes preserve account-scoped contacts",async()=>{
  const [server,migration,migrator]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/030_contact_profiles.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS contact_emails/);
  assert.match(migration,/contact_emails_one_primary_unique/);
  assert.match(migration,/REFERENCES contacts\(id\) ON DELETE CASCADE/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS contact_methods/);
  assert.match(migrator,/030_contact_profiles\.sql/);
  assert.match(migrator,/063_order_item_variant_snapshot\.sql/);
  assert.match(server,/\/api\/v1\/contacts/);
  assert.match(server,/contact\.profile\.update/);
  assert.match(server,/contact\.create/);
  assert.match(server,/contact\.delete/);
  assert.match(server,/contact\.avatar\.update/);
  assert.match(server,/phone_locked/);
  assert.match(server,/UPDATE contact_addresses SET label=/);
  assert.match(server,/DELETE FROM contact_addresses WHERE contact_id/);
  assert.match(server,/canAccessAccount/);
});

test("contact preferred language is persisted and exposed to the detail sidebar",async()=>{
  const [server,inbox,migration,migrator]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/050_contact_preferred_language.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS preferred_language varchar\(35\)/);
  assert.match(migrator,/050_contact_preferred_language\.sql/);
  assert.match(server,/preferred_language=CASE WHEN/);
  assert.match(server,/preferredLanguage:row\.preferred_language/);
  assert.match(inbox,/label="搜索联系人偏好语言"/);
  assert.match(inbox,/className="contact-preferred-language"/);
  assert.match(inbox,/<LanguageFlagIcon code=\{details\.contact\.preferredLanguage\} countryCode=\{details\.contact\.country\} title=\{details\.contact\.country\?countryLabel\(details\.contact\.country\):undefined\}\/>/);
  assert.match(inbox,/languageShortCode\(details\.contact\.preferredLanguage\)/);
});

test("contact blocking is available from conversation and contact workflows",async()=>{
  const [server,inbox]=await Promise.all([
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(server,/a\.platform,a\.transport,co\.provider_user_id/);
  assert.match(server,/transport:String\(row\.transport\?\?"web"\)/);
  assert.match(inbox,/function ConversationContextMenu/);
  assert.match(inbox,/async function toggleContactBlock/);
  assert.match(inbox,/async function toggleBlock\(contact:ContactProfile\)/);
  assert.match(inbox,/contact-profile-edit contact-block-button/);
  assert.match(inbox,/contact\.transport==="web"/);
});

test("contact avatars reuse the account media picker",async()=>{
  const [inbox,mediaDialog]=await Promise.all([
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/product-image-media-dialog.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(inbox,/title="选择联系人头像"/);
  assert.match(inbox,/libraryPath=\{`\/api\/v1\/media\?accountId=/);
  assert.match(inbox,/acceptedMimeTypes=\{\["image\/jpeg","image\/png","image\/webp"\]\}/);
  assert.match(inbox,/maxFileSize=\{5\*1024\*1024\}/);
  assert.match(mediaDialog,/acceptedMimeTypes=/);
  assert.match(mediaDialog,/item\.size<=maxFileSize/);
});
