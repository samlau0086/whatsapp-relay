import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("order and product import migrations are included in startup migrations",async()=>{
  const [migrator,inquiryMigration,importMigration]=await Promise.all([
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/080_inquiry_order_template.sql",import.meta.url),"utf8"),
    readFile(new URL("../../../infra/postgres/migrations/081_product_import_sources.sql",import.meta.url),"utf8"),
  ]);
  assert.match(migrator,/079_order_item_external_urls\.sql/);
  assert.match(migrator,/080_inquiry_order_template\.sql/);
  assert.match(migrator,/081_product_import_sources\.sql/);
  assert.match(inquiryMigration,/inq_template/);
  assert.match(importMigration,/product_import_sources/);
});