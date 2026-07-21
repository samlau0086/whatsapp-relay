import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("product library migration is idempotent and does not backfill historical orders",async()=>{
  const migration=await readFile(new URL("../../../infra/postgres/migrations/012_product_library.sql",import.meta.url),"utf8");
  assert.match(migration,/CREATE TABLE IF NOT EXISTS products/);
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_labels/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS product_id/);
  assert.match(migration,/ON DELETE SET NULL/);
  assert.doesNotMatch(migration,/INSERT INTO products[\s\S]*SELECT[\s\S]*order_items/i);
});

test("product routes enforce shared media, snapshots, idempotency, and soft deletion",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/app\.get\("\/api\/v1\/products"/);
  assert.match(server,/app\.post\("\/api\/v1\/products\/media"/);
  assert.match(server,/app\.get\("\/api\/v1\/products\/media"/);
  assert.match(server,/mime_type IN \('image\/png','image\/jpeg'\)/);
  assert.match(server,/account_id IS NULL AND status='ready'/);
  assert.match(server,/client_product_id=\$1/);
  assert.match(server,/订单 #\$\{orderNumber\}/);
  assert.match(server,/SELECT t\.name,t\.color FROM conversation_tags/);
  assert.match(server,/deleted_at=now\(\),updated_at=now\(\)/);
  assert.match(server,/INSERT INTO order_items\(order_id,position,product_name,quantity,unit_amount,image_media_id,product_id\)/);
  assert.match(server,/product\.create/);
  assert.match(server,/product\.update/);
  assert.match(server,/product\.delete/);
  assert.match(server,/app\.post\("\/api\/v1\/products\/bulk-import"/);
  assert.match(server,/source:"csv_import"/);
});

test("bulk product import validates batches and is capped at 500 rows",async()=>{
  const schemas=await readFile(new URL("../src/schemas.ts",import.meta.url),"utf8");
  assert.match(schemas,/productBulkImportSchema/);
  assert.match(schemas,/\.min\(1\)\.max\(500\)/);
  assert.match(schemas,/duplicate sku in import/);
});

test("product descriptions and CSV image references are supported",async()=>{
  const [migration,server,dialog]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/027_product_description.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/product-import-dialog.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS description/);
  assert.match(server,/p\.description/);
  assert.match(server,/product\.imageMediaId/);
  assert.match(dialog,/imageFileName/);
  assert.match(dialog,/选择多张图片/);
  assert.match(dialog,/产品描述/);
});

test("the product editor previews the selected media image",async()=>{
  const dialog=await readFile(new URL("../../../app/product-editor-dialog.tsx",import.meta.url),"utf8");
  assert.match(dialog,/MediaImagePreview/);
  assert.match(dialog,/product-dialog-image-preview/);
  assert.match(dialog,/产品图片预览/);
});
