import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverFile = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const productId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const clientProductId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const product = { id: productId, sku: "P-1", name: "Product", currency: "USD", isInStock: true, priceTiers: [{ minQuantity: 1, unitAmount: 12, costAmount: 6, profitMargin: 50 }], supplierLinks: [{ url: "private" }], internalNote: "private", variants: [{ sku: "P-1-R", attributes: { color: "red" }, priceTiers: [{ minQuantity: 1, unitAmount: 13, costAmount: 7 }] }] };

async function connect(apiBaseUrl: string, writeScopes = "") {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", serverFile], env: { ...process.env, RELAY_API_BASE_URL: apiBaseUrl, RELAY_API_KEY: "rdk_test_secret", RELAY_ACCOUNT_ID: accountId, RELAY_MCP_WRITE_SCOPES: writeScopes }, stderr: "pipe" });
  const client = new Client({ name: "relaydesk-products-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("product tools use workspace scope, redact internal fields, and gate writes", async () => {
  const requests: Array<{ method: string; url: URL; body: Record<string, unknown> }> = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
    requests.push({ method: req.method ?? "", url, body });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.pathname === "/api/v1/products") res.end(JSON.stringify({ data: [product], total: 2, hasMore: url.searchParams.get("offset") !== "1", nextOffset: 1 }));
    else if (url.pathname === "/api/v1/products/query") res.end(JSON.stringify({ data: body.skus?.includes("P-1") ? [product] : [], missingSkus: [] }));
    else if (req.method === "POST") res.end(JSON.stringify({ ...product, deduplicated: false }));
    else if (url.pathname === "/api/v1/products/bulk-update") res.end(JSON.stringify({ updated: 1, products: [product] }));
    else res.end(JSON.stringify({ id: productId, isInStock: false }));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const reader = await connect(url);
    try {
      const names = (await reader.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes("search_products"));
      assert.ok(names.includes("get_product_by_sku"));
      assert.ok(!names.includes("create_product"));
      const catalog = await reader.callTool({ name: "list_mcp_operations", arguments: {} });
      assert.equal((catalog.structuredContent?.data as Array<{ name: string; enabled: boolean }>).find(row => row.name === "create_product")?.enabled, false);
      const first = await reader.callTool({ name: "search_products", arguments: { query: "Product", limit: 1, stock: "in_stock" } });
      assert.equal(first.isError, undefined);
      assert.equal(first.structuredContent?.meta && (first.structuredContent.meta as { accountScope: string }).accountScope, "workspace");
      assert.equal(JSON.stringify(first.structuredContent).includes("costAmount"), false);
      assert.equal(JSON.stringify(first.structuredContent).includes("supplierLinks"), false);
      assert.equal(JSON.stringify(first.structuredContent).includes("internalNote"), false);
      assert.equal(requests[0].url.searchParams.get("accountId"), null);
      assert.equal(requests[0].url.searchParams.get("stock"), "in_stock");
      const next = await reader.callTool({ name: "search_products", arguments: { limit: 1, cursor: first.structuredContent?.nextCursor } });
      assert.equal(requests[1].url.searchParams.get("offset"), "1");
      assert.equal(next.structuredContent?.nextCursor, null);
      const invalid = await reader.callTool({ name: "search_products", arguments: { limit: 101 } });
      assert.equal(invalid.isError, true);
      assert.equal(requests.length, 2);
      const bySku = await reader.callTool({ name: "get_product_by_sku", arguments: { sku: "P-1" } });
      assert.equal((bySku.structuredContent?.data as { sku: string }).sku, "P-1");
      assert.deepEqual(requests[2].body, { skus: ["P-1"] });
      const missing = await reader.callTool({ name: "get_product_by_sku", arguments: { sku: "missing" } });
      assert.equal(JSON.parse((missing.content as Array<{ text: string }>)[0].text).error.code, "not_found");
    } finally { await reader.close(); }

    const writer = await connect(url, "products:write");
    try {
      const names = (await writer.listTools()).tools.map(tool => tool.name);
      for (const name of ["create_product", "update_product", "set_product_stock"]) assert.ok(names.includes(name));
      const create = { clientProductId, sku: "P-1", name: "Product", currency: "USD", priceTiers: [{ minQuantity: 1, unitAmount: 12 }] };
      const count = requests.length;
      assert.equal((await writer.callTool({ name: "create_product", arguments: create })).isError, true);
      assert.equal((await writer.callTool({ name: "update_product", arguments: { sku: "P-1", name: "New" } })).isError, true);
      assert.equal((await writer.callTool({ name: "set_product_stock", arguments: { productId, isInStock: false } })).isError, true);
      assert.equal(requests.length, count);
      const created = await writer.callTool({ name: "create_product", arguments: { ...create, confirm: true } });
      assert.equal(created.isError, undefined);
      assert.deepEqual(requests[count].body, create);
      assert.equal(requests[count].url.searchParams.get("accountId"), null);
      assert.equal(JSON.stringify(created.structuredContent).includes("costAmount"), false);
      const empty = await writer.callTool({ name: "update_product", arguments: { sku: "P-1", confirm: true } });
      assert.equal(empty.isError, true);
      assert.equal(requests.length, count + 1);
      await writer.callTool({ name: "update_product", arguments: { sku: "P-1", tags: [], confirm: true } });
      assert.deepEqual(requests[count + 1].body, { products: [{ sku: "P-1", tags: [] }] });
      await writer.callTool({ name: "set_product_stock", arguments: { productId, isInStock: false, confirm: true } });
      assert.equal(requests[count + 2].url.pathname, `/api/v1/products/${productId}/stock`);
      assert.deepEqual(requests[count + 2].body, { isInStock: false });
    } finally { await writer.close(); }
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }
});
