import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("order and product import migrations are included in startup migrations",async()=>{
  const [migrator,inquiryMigration,importMigration,stockMigration,usernameMigration,optionalIdentityMigration,contactSearchUsernameMigration]=await Promise.all([
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/080_inquiry_order_template.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/081_product_import_sources.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/082_product_stock_status.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/083_contact_whatsapp_username.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/084_contact_provider_identity_optional.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/085_contact_search_username_index.sql",import.meta.url),"utf8"),
  ]);
  assert.match(migrator,/079_order_item_external_urls\.sql/);
  assert.match(migrator,/080_inquiry_order_template\.sql/);
  assert.match(migrator,/081_product_import_sources\.sql/);
  assert.match(migrator,/082_product_stock_status\.sql/);
  assert.match(migrator,/083_contact_whatsapp_username\.sql/);
  assert.match(migrator,/084_contact_provider_identity_optional\.sql/);
  assert.match(migrator,/085_contact_search_username_index\.sql/);
  assert.match(inquiryMigration,/inq_template/);
  assert.match(importMigration,/product_import_sources/);
  assert.match(stockMigration,/is_out_of_stock/);
  assert.match(usernameMigration,/whatsapp_username/);
  assert.match(optionalIdentityMigration,/provider_user_id/);
  assert.match(optionalIdentityMigration,/DROP NOT NULL/);
  assert.match(contactSearchUsernameMigration,/whatsapp_username/);
  assert.match(contactSearchUsernameMigration,/pg_get_indexdef/);
  assert.match(contactSearchUsernameMigration,/contacts_channel_search_trgm_idx/);
});
