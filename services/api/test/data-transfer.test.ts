import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("contacts, orders, and products expose CSV import and export controls",async()=>{
  const [inbox,dialog,csv,productImport,server]=await Promise.all([
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/data-import-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/csv-transfer.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/product-import-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.equal((inbox.match(/(?:一键导入|智能导入)/g)??[]).length,6);
  assert.equal((inbox.match(/一键导出/g)??[]).length,3);
  assert.match(dialog,/contacts:\{/);
  assert.match(dialog,/orders:\{/);
  assert.match(dialog,/每次最多导入 500 行/);
  assert.match(dialog,/重复号码会更新资料/);
  assert.match(csv,/replace\(\/"\/g,'""'\)/);
  assert.match(productImport,/weight_amount/);
  assert.match(server,/o\.business_status/);
});
