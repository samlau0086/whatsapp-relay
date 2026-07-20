import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { calculateOrderTotal, canManageSharedRecord, formatOrderSummary, preferredCustomerStage } from "../src/crm.js";

test("shared notes remain owner-managed with supervisor override",()=>{
  assert.equal(canManageSharedRecord("agent","user-1","user-1"),true);
  assert.equal(canManageSharedRecord("agent","user-1","user-2"),false);
  assert.equal(canManageSharedRecord("supervisor","user-1","user-2"),true);
  assert.equal(canManageSharedRecord("admin",null,"user-2"),true);
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
  assert.match(server,/renderOrderImage/);
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
  assert.match(server,/COALESCE\(NULLIF\(co\.alias,''\),co\.display_name,co\.phone_e164\)/);
  assert.match(hub,/const bestAlias=/);
  assert.doesNotMatch(hub,/UPDATE contacts SET[^\n]*alias=COALESCE\(NULLIF\(EXCLUDED\.display_name/);
});
