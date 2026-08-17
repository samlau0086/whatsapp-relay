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

test("product library offers a 36-item page size",async()=>{
  const component=await readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
  assert.match(component,/PRODUCT_PAGE_SIZES = \[24,32,36,48,64\]/);
});

test("product routes enforce shared media, snapshots, idempotency, and soft deletion",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/app\.get\("\/api\/v1\/products"/);
  assert.match(server,/COUNT\(\*\) OVER\(\)::int total_count/);
  assert.match(server,/tags:tagOptions\.rows/);
  assert.match(server,/app\.post\("\/api\/v1\/products\/media"/);
  assert.match(server,/app\.get\("\/api\/v1\/products\/media"/);
  assert.match(server,/mime_type IN \('image\/png','image\/jpeg'\)/);
  assert.match(server,/account_id IS NULL AND status='ready'/);
  assert.match(server,/client_product_id=\$1/);
  assert.match(server,/订单 #\$\{orderNumber\}/);
  assert.match(server,/SELECT t\.name,t\.color FROM conversation_tags/);
  assert.match(server,/deleted_at=now\(\),updated_at=now\(\)/);
  assert.match(server,/INSERT INTO order_items\(order_id,position,product_name,product_sku,quantity,unit_amount,weight_amount,weight_unit,image_media_id,product_id,variant_id,shipping_class_id,shipping_class_name,internal_note_snapshot\)/);
  assert.match(server,/product\.create/);
  assert.match(server,/product\.update/);
  assert.match(server,/product\.delete/);
  assert.match(server,/app\.post\("\/api\/v1\/products\/bulk-import"/);
  assert.match(server,/source:"csv_import"/);
});

test("bulk product import validates batches and is capped at 500 rows",async()=>{
  const [schemas,server,dialog]=await Promise.all([
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/product-import-dialog.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(schemas,/productBulkImportSchema/);
  assert.match(schemas,/\.min\(1\)\.max\(500\)/);
  assert.match(schemas,/duplicate sku in import/);
  assert.match(schemas,/priceTiers:productPriceTiersSchema\.optional\(\)/);
  assert.match(server,/ON CONFLICT \(lower\(btrim\(sku\)\)\) WHERE deleted_at IS NULL DO UPDATE SET name=EXCLUDED\.name/);
  assert.match(server,/new_product_fields_required/);
  assert.match(server,/fields:Object\.keys\(product\)/);
  assert.match(server,/replaceProductPriceTiers\(client,productId,product\.priceTiers\)/);
  assert.match(server,/replaceProductLabels\(client,productId,product\.tags\)/);
  assert.match(server,/return\{\.\.\.counts,products\}/);
  assert.doesNotMatch(server,/if\(existing\.rowCount\)return reply\.code\(409\)/);
  assert.match(dialog,/const updateOnly=!currency&&!price&&!tierText/);
});

test("product automation can query and atomically update products by SKU",async()=>{
  const [schemas,server]=await Promise.all([
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(schemas,/productSkuQuerySchema/);
  assert.match(schemas,/productBulkUpdateSchema/);
  assert.match(server,/app\.post\("\/api\/v1\/products\/query"/);
  assert.match(server,/app\.patch\("\/api\/v1\/products\/bulk-update"/);
  assert.match(server,/lower\(btrim\(p\.sku\)\)=ANY/);
  assert.match(server,/source:"sku_bulk_update"/);
  assert.match(server,/missingSkus/);
  assert.match(server,/hasScope\(request\.principal,"products:read"\)/);
  assert.match(server,/hasScope\(request\.principal,"products:write"\)/);
  assert.match(server,/replaceProductLabels\(client,current\.id,update\.tags\)/);
});

test("administrators can manage scoped API keys from the web settings page",async()=>{
  const [schemas,server,component,css]=await Promise.all([
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(schemas,/apiKeyCreateSchema/);
  assert.match(server,/app\.get\("\/api\/v1\/api-keys"/);
  assert.match(server,/app\.post\("\/api\/v1\/api-keys"/);
  assert.match(server,/app\.delete\("\/api\/v1\/api-keys\/:id"/);
  assert.match(server,/api_key\.create/);
  assert.match(server,/api_key\.revoke/);
  assert.match(component,/function ApiKeySettingsPanel/);
  assert.match(component,/products:read/);
  assert.match(component,/products:write/);
  assert.match(component,/API 密钥/);
  assert.match(component,/密钥仅在创建后显示一次/);
  assert.match(css,/\.api-key-settings/);
  assert.doesNotMatch(server,/SELECT [^;]*secret_hash[^;]*FROM api_keys ORDER BY/);
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
  assert.match(dialog,/product-variant-image-preview/);
  assert.match(dialog,/移除变体图片/);
  const mediaDialog=await readFile(new URL("../../../app/product-image-media-dialog.tsx",import.meta.url),"utf8");
  assert.match(mediaDialog,/requestRef=useRef\(request\)/);
  assert.match(mediaDialog,/\},\[mediaId\]\)/);
});

test("product card sending recovers from a lost response without duplicating the batch",async()=>{
  const [dialog,server]=await Promise.all([
    readFile(new URL("../../../app/product-card-send-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(dialog,/pendingBatchRef/);
  assert.match(dialog,/requestJsonWithTimeout/);
  assert.match(dialog,/waitForBatch/);
  assert.match(dialog,/正在确认发送状态/);
  assert.match(server,/product-cards\/batches\/:batchId/);
  assert.match(server,/left\(client_message_id,length\(\$3\)\+1\)=\$3\|\|':'/);
});

test("product cards load variant media and render all variant price tiers",async()=>{
  const [server,image]=await Promise.all([readFile(new URL("../src/server.ts",import.meta.url),"utf8"),readFile(new URL("../src/product-card-image.ts",import.meta.url),"utf8")]);
  assert.match(server,/'objectKey',vm\.object_key/);
  assert.match(server,/LEFT JOIN media vm ON vm\.id=v\.image_media_id AND vm\.status='ready'/);
  assert.match(server,/loadProductCardImage\(variant\.objectKey\)/);
  assert.match(image,/variantImageData/);
  assert.match(image,/const groups=product\.variants\?\.length\?product\.variants\.map/);
  assert.match(image,/Object\.entries\(variant\.attributes\)/);
  assert.match(image,/\["SKU",skuX,skuWidth\],\["QTY",qtyX,qtyWidth\],\["Price",priceX,priceWidth\]/);
  assert.match(image,/const showImage=Boolean\(product\.variants\?\.some/);
  assert.doesNotMatch(image,/variant\.priceTiers\[0\]/);
});

test("variant products persist their selected order-item variant",async()=>{
  const [migration,server,inbox]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/063_order_item_variant_snapshot.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.ok(migration.indexOf("CREATE TABLE IF NOT EXISTS product_variants")<migration.indexOf("ADD COLUMN IF NOT EXISTS variant_id"));
  assert.match(migration,/CREATE TABLE IF NOT EXISTS product_variant_price_tiers/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS variant_id uuid REFERENCES product_variants\(id\) ON DELETE SET NULL/);
  assert.match(migration,/CREATE INDEX IF NOT EXISTS order_items_variant_idx/);
  assert.match(server,/'variantId',i\.variant_id/);
  assert.match(server,/productId,item\.variantId\?\?null,shippingClass/);
  assert.match(inbox,/chooseCatalogVariant/);
  assert.match(inbox,/variantId:product\.variantId\?String\(product\.variantId\):null/);
});

test("bulk product editing supports category and shipping class",async()=>{
  const [schemas,server,component]=await Promise.all([
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(schemas,/bulkCategoryOperation/);
  assert.match(schemas,/bulkShippingClassOperation/);
  assert.match(server,/operation\.field==="category"/);
  assert.match(server,/operation\.field==="shippingClass"/);
  assert.match(server,/shippingClassExists\(client,operation\.shippingClassId,true\)/);
  assert.match(component,/selectField\("category"\)/);
  assert.match(component,/selectField\("shippingClass"\)/);
});

test("product card sending offers preset and custom grid collages",async()=>{
  const [dialog,server,image]=await Promise.all([readFile(new URL("../../../app/product-card-send-dialog.tsx",import.meta.url),"utf8"),readFile(new URL("../src/server.ts",import.meta.url),"utf8"),readFile(new URL("../src/product-card-image.ts",import.meta.url),"utf8")]);
  assert.match(dialog,/GRID_PRESETS\s*=\s*\[2,\s*3,\s*4,\s*5,\s*8\]/);assert.match(dialog,/合并为网格拼图/);assert.match(dialog,/自定义/);assert.match(dialog,/gridPageCount/);assert.match(server,/renderProductCardGridPages/);assert.match(server,/clientBatchId}:grid:\$\{index\}/);assert.match(image,/export async function renderProductCardGridPages/);
});

test("product card captions come from the template and are translated before WhatsApp sending",async()=>{
  const [dialog,editor,server]=await Promise.all([
    readFile(new URL("../../../app/product-card-send-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/product-card-template-editor.tsx",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(editor,/默认图片说明/);
  assert.match(editor,/\{\{productCount\}\}/);
  assert.match(dialog,/\/api\/v1\/product-card-template/);
  assert.match(dialog,/\/api\/v1\/translations\/preview/);
  assert.match(dialog,/\/api\/v1\/translations\/product-names\/preview/);
  assert.match(dialog,/确认产品卡片翻译/);
  assert.match(dialog,/自动翻译产品名称/);
  assert.match(dialog,/translationSourceText/);
  assert.match(dialog,/translationTargetLanguage/);
  assert.match(server,/renderProductCardCaption/);
  assert.match(server,/text_content,translation_source_text,translation_target_language,media_id/);
});

test("product card search queries the complete product library and preserves selected products",async()=>{
  const [dialog,server]=await Promise.all([
    readFile(new URL("../../../app/product-card-send-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(dialog,/params\.set\("q",\s*needle\)/);
  assert.match(dialog,/params\.set\("category",\s*category\)/);
  assert.match(dialog,/setProductCache/);
  assert.match(dialog,/productCache\.get\(id\)/);
  assert.match(dialog,/toggleAllVisible/);
  assert.match(dialog,/if \(next\.length >= 50\) break/);
  assert.match(dialog,/all\.filter\(\(id\) => !visible\.has\(id\)\)/);
  assert.match(server,/search_label\.name ILIKE/);
  assert.match(server,/lower\(p\.category\)=lower\(\$5\)/);
});

test("product card search can exactly match a complete SKU or product title",async()=>{
  const [dialog,server,css]=await Promise.all([
    readFile(new URL("../../../app/product-card-send-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/globals.css",import.meta.url),"utf8"),
  ]);
  assert.match(dialog,/精准匹配/);
  assert.match(dialog,/role="switch"/);
  assert.match(dialog,/if \(exactMatch\) params\.set\("exact",\s*"true"\)/);
  assert.match(server,/lower\(btrim\(p\.name\)\)=lower\(\$1\)/);
  assert.match(server,/lower\(btrim\(p\.sku\)\)=lower\(\$1\)/);
  assert.match(server,/invalid_exact_match/);
  assert.match(css,/\.product-card-exact-toggle/);
});

test("product management offers compact card and list views",async()=>{
  const [component,css]=await Promise.all([readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),readFile(new URL("../../../app/globals.css",import.meta.url),"utf8")]);
  assert.match(component,/aria-label="卡片视图"/);
  assert.match(component,/aria-label="列表视图"/);
  assert.match(component,/product-grid \$\{view\}-view/);
  assert.match(css,/\.product-grid\.card-view/);
  assert.match(css,/\.product-grid\.list-view/);
});

test("product pagination includes nearby pages, boundary shortcuts, and direct jump",async()=>{
  const component=await readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
  assert.match(component,/current-3/);
  assert.match(component,/current\+3/);
  assert.match(component,/product-pagination-ellipsis/);
  assert.match(component,/跳转页码/);
  assert.match(component,/jumpToPage/);
  assert.match(component,/PRODUCT_PAGE_SIZES = \[24,32,36,48,64\]/);
  assert.match(component,/aria-label="每页产品数"/);
  assert.match(component,/Math\.ceil\(total\/pageSize\)/);
});

test("product pagination uses bounded stale-while-revalidate data and media caches",async()=>{
  const component=await readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
  assert.match(component,/const PRODUCT_PAGE_CACHE_TTL=60_000/);
  assert.match(component,/const PRODUCT_PAGE_CACHE_LIMIT=60/);
  assert.match(component,/const PRODUCT_CURRENCY_CACHE_TTL=5\*60_000/);
  assert.match(component,/const productPageFlights=new Map/);
  assert.match(component,/cached&&fresh&&cachedCurrency&&!options\.force/);
  assert.match(component,/adjacentPages=\[page-1,page\+1\]/);
  assert.match(component,/invalidateProductCache/);
  assert.match(component,/const cacheKey=`\$\{mediaId\}\$\{preview\?":preview":""\}`/);
  assert.match(component,/acquireMedia\(cacheKey/);
  assert.match(component,/rootMargin:"500px 0px"/);
});

test("product tags support searching, creating, editing, and deleting labels",async()=>{
  const [dialog,css,schemas,server]=await Promise.all([
    readFile(new URL("../../../app/product-editor-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/globals.css",import.meta.url),"utf8"),
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(dialog,/role="combobox"/);
  assert.match(dialog,/role="listbox"/);
  assert.match(dialog,/搜索或创建标签/);
  assert.match(dialog,/创建“\{tagName\.trim\(\)\}”/);
  assert.match(dialog,/products\.flatMap\(\(item\) => item\.tags\)/);
  assert.match(dialog,/setTags\(\(all\) =>\s*all\.map/);
  assert.match(dialog,/setTags\(\(all\) =>\s*all\.filter/);
  assert.match(dialog,/className="product-label-option-actions"/);
  assert.match(dialog,/aria-label={`编辑标签 \${tag\.name}`}/);
  assert.match(dialog,/aria-label={`删除标签 \${tag\.name}`}/);
  assert.match(dialog,/method: "PATCH"/);
  assert.match(dialog,/method: "DELETE"/);
  assert.match(css,/\.product-label-option-row:hover \.product-label-option-actions/);
  assert.match(css,/\.product-label-option-row:focus-within \.product-label-option-actions/);
  assert.match(css,/\.product-label-editor \.product-label-option-add\{[^}]*color:#34443c/);
  assert.match(schemas,/productLabelCatalogUpdateSchema/);
  assert.match(schemas,/productLabelCatalogDeleteSchema/);
  assert.match(server,/app\.patch\("\/api\/v1\/product-labels"/);
  assert.match(server,/app\.delete\("\/api\/v1\/product-labels"/);
  assert.match(server,/product_label\.update/);
  assert.match(server,/product_label\.delete/);
});

test("products persist category and brand and expose server-side filters",async()=>{
  const [migration,schemas,server,component,dialog]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/047_product_category_brand.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/product-editor-dialog.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS category/);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS brand/);
  assert.match(schemas,/category:z\.string\(\)\.trim\(\)\.max\(80\)/);
  assert.match(schemas,/brand:z\.string\(\)\.trim\(\)\.max\(80\)/);
  assert.match(server,/query\.category\?\.trim\(\)/);
  assert.match(server,/query\.brand\?\.trim\(\)/);
  assert.match(component,/aria-label="按分类筛选"/);
  assert.match(component,/aria-label="按品牌筛选"/);
  assert.match(dialog,/label="分类"/);
  assert.match(dialog,/label="品牌"/);
  assert.match(dialog,/function SearchableCreatableField/);
  assert.match(dialog,/role="combobox"/);
  assert.match(dialog,/创建“\{query\.trim\(\)\}”/);
  assert.match(dialog,/products\.map\(\(item\) => item\.category\)/);
  assert.match(dialog,/products\.map\(\(item\) => item\.brand\)/);
});

test("API startup applies the latest product schema to persistent databases",async()=>{
  const runner=await readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8");
  assert.match(runner,/024_product_pricing_cards\.sql/);
  assert.match(runner,/025_currency_management\.sql/);
  assert.match(runner,/027_product_description\.sql/);
  assert.match(runner,/047_product_category_brand\.sql/);
  assert.match(runner,/062_product_internal_pricing\.sql/);
  assert.match(runner,/070_product_gallery\.sql/);
});

test("products support internal tier pricing, supplier links, and private order-note snapshots",async()=>{
  const [migration,schemas,server,dialog,component]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/062_product_internal_pricing.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/schemas.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../app/product-editor-dialog.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/supplier_links jsonb/);
  assert.match(migration,/internal_note text/);
  assert.match(migration,/to_regclass\('public\.product_variant_price_tiers'\)[\s\S]*cost_amount/);
  assert.match(migration,/internal_note_snapshot/);
  assert.match(schemas,/unit amount must match cost amount and profit margin/);
  assert.match(schemas,/supplyPrice:moneySchema\.optional\(\)/);
  assert.match(schemas,/value\.costAmount\/\(1-value\.profitMargin\/100\)/);
  const editor=await readFile(new URL("../../../app/product-editor-dialog.tsx",import.meta.url),"utf8");
  assert.match(editor,/cost\/\(1-margin\/100\)/);
  assert.match(server,/supplier_links=CASE WHEN/);
  assert.match(server,/INSERT INTO product_price_tiers\(product_id,min_quantity,unit_amount,cost_amount,profit_margin\)/);
  const crm=await readFile(new URL("../src/crm.ts",import.meta.url),"utf8");
  assert.match(crm,/ALTER TABLE product_variant_price_tiers ADD COLUMN IF NOT EXISTS cost_amount/);
  assert.match(server,/internal_note_snapshot\) VALUES/);
  assert.match(server,/'internalNote',i\.internal_note_snapshot/);
  assert.match(dialog,/calculatedPrice/);
  assert.match(dialog,/供应商链接/);
  assert.match(dialog,/aria-label="供应价格"/);
  assert.match(dialog,/supplyPrice:Number\(link\.supplyPrice\)/);
  assert.match(dialog,/内部备注 · 仅内部可见/);
  assert.match(component,/order-item-internal-note/);
  assert.match(component,/order-item-cost/);
  assert.match(server,/attachInternalOrderItemCosts/);
  const cardRoute=server.slice(server.indexOf('app.post("/api/v1/product-cards"'),server.indexOf('app.get("/api/v1/product-cards/batches'));
  const orderRender=server.slice(server.indexOf('app.post("/api/v1/conversations/:conversationId/orders/:orderId/send"'),server.indexOf('app.post("/api/v1/conversations/:id/orders"'));
  assert.doesNotMatch(cardRoute,/internal_note|supplier_links|cost_amount|profit_margin/);
  assert.doesNotMatch(orderRender,/internal_note_snapshot/);
});
