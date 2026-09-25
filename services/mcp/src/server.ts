import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { loadContext, WRITE_SCOPES } from "./context.js";
import { RelayApiClient, RelayApiError } from "./relay-api-client.js";

const context = loadContext();
const api = new RelayApiClient(context);
const server = new McpServer({ name: "relaydesk-mcp", version: "0.1.0" });
const pageSize = z.number().int().min(1).max(100).default(40);
const cursor = z.string().max(512).optional();

function wrapped<TArgs>(tool: string, handler: (args: TArgs) => Promise<unknown>, workspace = false) {
  return async (args: TArgs) => {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      const data = await handler(args);
      const body = data && typeof data === "object" && "data" in data ? data as { data: unknown; nextCursor?: unknown; total?: unknown; hasMore?: unknown } : { data };
      const output = body.data;
      const count = Array.isArray(output) ? output.length : undefined;
      const nextCursor = body.nextCursor ?? null;
      const payload = { data: output, meta: { accountScope: workspace ? "workspace" : context.accountId ?? "all", ...(body.total === undefined ? {} : { total: body.total }), ...(body.hasMore === undefined ? {} : { hasMore: body.hasMore }) }, nextCursor, requestId };
      audit({ tool, accountId: context.accountId, requestId, ok: true, durationMs: Date.now() - started, resultCount: count });
      return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], structuredContent: payload };
    } catch (error) {
      const code = error instanceof RelayApiError ? error.code : "upstream_unavailable";
      audit({ tool, accountId: context.accountId, requestId, ok: false, durationMs: Date.now() - started, errorCode: code });
      const message = error instanceof RelayApiError ? error.message : code;
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message }, requestId }) }] };
    }
  };
}

const operationCatalog = [
  { name: "list_conversations", mode: "read", scope: null, description: "查询会话列表" },
  { name: "get_conversation", mode: "read", scope: null, description: "查询会话摘要" },
  { name: "list_messages", mode: "read", scope: null, description: "查询会话消息" },
  { name: "search_contacts", mode: "read", scope: null, description: "搜索联系人" },
  { name: "get_contact", mode: "read", scope: null, description: "查询联系人资料" },
  { name: "list_whatsapp_groups", mode: "read", scope: null, description: "查询 WhatsApp 群组" },
  { name: "get_conversation_details", mode: "read", scope: null, description: "查询会话标签、备注、提醒和订单摘要" },
  { name: "list_tags", mode: "read", scope: null, description: "查询可用标签及其 ID" },
  { name: "search_products", mode: "read", scope: "products:read", description: "搜索工作区产品库" },
  { name: "get_product_by_sku", mode: "read", scope: "products:read", description: "按 SKU 查询产品" },
  { name: "send_message", mode: "write", scope: "messages:send", description: "发送单条文本消息" },
  { name: "update_conversation", mode: "write", scope: "conversations:write", description: "更新会话状态、收藏、已读状态或客户阶段" },
  { name: "set_conversation_tags", mode: "write", scope: "conversations:write", description: "整体替换会话标签" },
  { name: "add_conversation_note", mode: "write", scope: "conversations:write", description: "添加会话团队备注" },
  { name: "update_contact", mode: "write", scope: "contacts:write", description: "更新联系人有限资料字段" },
  { name: "retry_message", mode: "write", scope: "messages:send", description: "重试失败或不确定的出站消息" },
  { name: "create_product", mode: "write", scope: "products:write", description: "创建产品" },
  { name: "update_product", mode: "write", scope: "products:write", description: "按 SKU 更新产品基础资料" },
  { name: "set_product_stock", mode: "write", scope: "products:write", description: "切换产品库存状态" },
] as const;

server.registerTool("list_mcp_operations", {
  description: "List all RelayDesk MCP operations, including disabled write operations and the scope required to enable them.",
  inputSchema: { includeDisabled: z.boolean().optional().describe("Include operations that are not enabled by the current MCP configuration.") },
}, wrapped<{ includeDisabled?: boolean }>("list_mcp_operations", async () => ({
  data: operationCatalog.map(operation => ({
    ...operation,
    enabled: operation.mode === "read" || context.writeScopes.has(operation.scope as typeof WRITE_SCOPES[number]),
  })),
  meta: { writeScopes: [...context.writeScopes] },
})));

type ConversationArgs = { status?: "open" | "closed" | "archived"; filter?: "all" | "groups" | "mine" | "unassigned" | "favorite" | "closed" | "archived" | "reminders" | "blocked"; query?: string; unreadOnly?: boolean; limit: number; cursor?: string; before?: string; lastMessageFrom?: string; lastMessageBefore?: string };
server.registerTool("list_conversations", { description: "List conversations for the bound WhatsApp account.", inputSchema: { status: z.enum(["open", "closed", "archived"]).optional(), filter: z.enum(["all", "groups", "mine", "unassigned", "favorite", "closed", "archived", "reminders", "blocked"]).optional(), query: z.string().max(100).optional(), unreadOnly: z.boolean().optional(), limit: pageSize, cursor, before: z.string().datetime().optional(), lastMessageFrom: z.string().datetime().optional(), lastMessageBefore: z.string().datetime().optional() } }, wrapped<ConversationArgs>("list_conversations", (args) => api.get("/conversations", { status: args.status, filter: args.filter, q: args.query, unreplied: args.unreadOnly ? "true" : undefined, limit: args.limit, cursor: args.cursor, before: args.before, lastMessageFrom: args.lastMessageFrom, lastMessageBefore: args.lastMessageBefore })));

type IdArgs = { conversationId: string };
server.registerTool("get_conversation", { description: "Get a conversation summary by ID.", inputSchema: { conversationId: z.string().uuid() } }, wrapped<IdArgs>("get_conversation", ({ conversationId }) => api.get(`/conversations/${conversationId}/summary`)));

type MessageArgs = IdArgs & { limit: number; cursor?: string; before?: string; direction?: "in" | "out"; from?: string; until?: string };
server.registerTool("list_messages", { description: "List messages in a conversation with cursor pagination.", inputSchema: { conversationId: z.string().uuid(), limit: pageSize, cursor, before: z.string().datetime().optional(), direction: z.enum(["in", "out"]).optional(), from: z.string().datetime().optional(), until: z.string().datetime().optional() } }, wrapped<MessageArgs>("list_messages", ({ conversationId, limit, cursor, before, direction, from, until }) => api.get(`/conversations/${conversationId}/messages`, { limit, cursor, before, direction, from, until })));

type ContactSearchArgs = { query?: string; limit: number; cursor?: string; blacklist?: boolean };
type ContactListResponse = { data: unknown[]; total: number; hasMore: boolean; nextOffset: number };
server.registerTool("search_contacts", { description: "Search person contacts in the bound account.", inputSchema: { query: z.string().max(100).optional(), limit: pageSize, cursor, blacklist: z.boolean().optional() } }, wrapped<ContactSearchArgs>("search_contacts", async ({ query, limit, cursor, blacklist }) => {
  const offset = cursor ? decodeOffset(cursor) : 0;
  const body = await api.get<ContactListResponse>("/contacts", { q: query, limit, offset, blacklist: blacklist === undefined ? undefined : String(blacklist) });
  if (!Array.isArray(body.data) || typeof body.hasMore !== "boolean" || !Number.isInteger(body.nextOffset) || !Number.isInteger(body.total)) throw new RelayApiError("upstream_unavailable", 502, "Relay API returned an invalid contacts response; check RELAY_API_BASE_URL");
  return { ...body, nextCursor: body.hasMore ? encodeOffset(body.nextOffset) : null };
}));
server.registerTool("get_contact", { description: "Get a contact profile by ID.", inputSchema: { contactId: z.string().uuid() } }, wrapped<{ contactId: string }>("get_contact", ({ contactId }) => api.get(`/contacts/${contactId}`)));

type GroupArgs = { limit: number; cursor?: string };
server.registerTool("list_whatsapp_groups", { description: "List WhatsApp group conversations in the bound account.", inputSchema: { limit: pageSize, cursor } }, wrapped<GroupArgs>("list_whatsapp_groups", ({ limit, cursor }) => api.get("/conversations", { filter: "groups", limit, cursor })));
server.registerTool("get_conversation_details", { description: "Get tags, notes, reminder and order details for a conversation.", inputSchema: { conversationId: z.string().uuid() } }, wrapped<IdArgs>("get_conversation_details", ({ conversationId }) => api.get(`/conversations/${conversationId}/details`)));
server.registerTool("list_tags", { description: "List available tags and IDs for conversation tagging.", inputSchema: { limit: pageSize, cursor } }, wrapped<GroupArgs>("list_tags", async ({ limit, cursor }) => {
  const offset = cursor ? decodeOffset(cursor) : 0;
  const body = await api.get<{ data: unknown[] }>("/tags");
  if (!Array.isArray(body.data)) throw new RelayApiError("upstream_unavailable", 502);
  return { data: body.data.slice(offset, offset + limit), total: body.data.length, nextCursor: offset + limit < body.data.length ? encodeOffset(offset + limit) : null };
}));

type Product = Record<string, unknown> & { priceTiers?: Array<Record<string, unknown>>; variants?: Array<Record<string, unknown>> };
function publicProduct(product: Product) {
  const { id, sku, name, description, category, brand, currency, isInStock, defaultUnitAmount, priceTiers, tags, imageUrl, galleryImages, variants, createdAt, updatedAt } = product;
  const prices = (priceTiers ?? []).map(tier => ({ minQuantity: tier.minQuantity, unitAmount: tier.unitAmount }));
  return { id, sku, name, description, category, brand, currency, isInStock, defaultUnitAmount, priceTiers: prices, tags, imageUrl, galleryImages, variants: (variants ?? []).map(variant => ({ id: variant.id, sku: variant.sku, attributes: variant.attributes, priceTiers: Array.isArray(variant.priceTiers) ? variant.priceTiers.map((tier: Record<string, unknown>) => ({ minQuantity: tier.minQuantity, unitAmount: tier.unitAmount })) : [] })), createdAt, updatedAt };
}

type ProductSearchArgs = { query?: string; exact?: boolean; tag?: string; category?: string; brand?: string; currency?: string; stock?: "in_stock" | "out_of_stock"; limit: number; cursor?: string };
server.registerTool("search_products", { description: "Search the shared workspace product library. Requires products:read on the API key; results exclude internal cost, margin, notes and supplier links.", inputSchema: { query: z.string().trim().max(100).optional(), exact: z.boolean().optional(), tag: z.string().trim().max(40).optional(), category: z.string().trim().max(80).optional(), brand: z.string().trim().max(80).optional(), currency: z.string().regex(/^[A-Za-z]{3}$/).optional(), stock: z.enum(["in_stock", "out_of_stock"]).optional(), limit: pageSize, cursor } }, wrapped<ProductSearchArgs>("search_products", async ({ query, exact, tag, category, brand, currency, stock, limit, cursor }) => {
  const offset = cursor ? decodeOffset(cursor) : 0;
  const body = await api.getWorkspace<{ data: Product[]; total: number; hasMore: boolean; nextOffset: number | null }>("/products", { q: query, exact: exact === undefined ? undefined : String(exact), tag, category, brand, currency, stock, limit, offset });
  if (!Array.isArray(body.data) || !Number.isInteger(body.total) || typeof body.hasMore !== "boolean" || (body.hasMore && !Number.isInteger(body.nextOffset))) throw new RelayApiError("upstream_unavailable", 502);
  return { data: body.data.map(publicProduct), total: body.total, hasMore: body.hasMore, nextCursor: body.hasMore ? encodeOffset(body.nextOffset!) : null };
}, true));

server.registerTool("get_product_by_sku", { description: "Get a product from the shared workspace library by exact SKU. Requires products:read on the API key.", inputSchema: { sku: z.string().trim().min(1).max(80) } }, wrapped<{ sku: string }>("get_product_by_sku", async ({ sku }) => {
  const body = await api.writeWorkspace<{ data: Product[] }>("POST", "/products/query", { skus: [sku] });
  if (!Array.isArray(body.data)) throw new RelayApiError("upstream_unavailable", 502);
  if (!body.data.length) throw new RelayApiError("not_found", 404);
  return publicProduct(body.data[0]);
}, true));

const confirmation = z.literal(true).describe("Set only after approving this exact operation in the MCP client.");
const productLabels = z.array(z.object({ name: z.string().trim().min(1).max(40), color: z.string().regex(/^#[0-9A-Fa-f]{6}$/) })).max(30);
if (context.writeScopes.has("products:write")) {
  type CreateProductArgs = { clientProductId: string; sku: string; name: string; currency: string; priceTiers: Array<{ minQuantity: number; unitAmount: number }>; description?: string; category?: string; brand?: string; tags?: Array<{ name: string; color: string }>; isInStock?: boolean; confirm: true };
  server.registerTool("create_product", { description: "Create one product in the shared workspace library. Requires products:write on the API key, client approval, and a stable clientProductId UUID for retries. No images or internal costs.", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, inputSchema: { clientProductId: z.string().uuid(), sku: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(120), currency: z.string().regex(/^[A-Za-z]{3}$/), priceTiers: z.array(z.object({ minQuantity: z.number().int().min(1).max(999999), unitAmount: z.number().min(0).max(99999999.99) })).min(1).max(50).refine(tiers => tiers[0]?.minQuantity === 1 && tiers.every((tier, index) => index === 0 || tier.minQuantity > tiers[index - 1].minQuantity)), description: z.string().trim().max(2000).optional(), category: z.string().trim().max(80).optional(), brand: z.string().trim().max(80).optional(), tags: productLabels.optional(), isInStock: z.boolean().optional(), confirm: confirmation } }, wrapped<CreateProductArgs>("create_product", async ({ clientProductId, sku, name, currency, priceTiers, description, category, brand, tags, isInStock }) => {
    const fields = { clientProductId, sku, name, currency, priceTiers, description, category, brand, tags, isInStock };
    const product = await api.writeWorkspace<Product & { deduplicated: boolean }>("POST", "/products", fields);
    return { ...publicProduct(product), deduplicated: product.deduplicated };
  }, true));
  type UpdateProductArgs = { sku: string; name?: string; description?: string; category?: string; brand?: string; tags?: Array<{ name: string; color: string }>; confirm: true };
  server.registerTool("update_product", { description: "Update one product by SKU (name, description, category, brand or replacement tags). Requires products:write and client approval.", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: { sku: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(2000).optional(), category: z.string().trim().max(80).optional(), brand: z.string().trim().max(80).optional(), tags: productLabels.optional(), confirm: confirmation } }, wrapped<UpdateProductArgs>("update_product", async ({ sku, name, description, category, brand, tags }) => {
    if ([name, description, category, brand, tags].every(value => value === undefined)) throw new RelayApiError("invalid_argument", 400);
    const fields = { sku, name, description, category, brand, tags };
    const result = await api.writeWorkspace<{ products: Product[] }>("PATCH", "/products/bulk-update", { products: [fields] });
    if (!Array.isArray(result.products) || result.products.length !== 1) throw new RelayApiError("upstream_unavailable", 502);
    return publicProduct(result.products[0]);
  }, true));
  server.registerTool("set_product_stock", { description: "Set stock availability for one product by ID in the shared workspace library. Requires products:write and client approval.", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: { productId: z.string().uuid(), isInStock: z.boolean(), confirm: confirmation } }, wrapped<{ productId: string; isInStock: boolean; confirm: true }>("set_product_stock", ({ productId, isInStock }) => api.writeWorkspace("PATCH", `/products/${productId}/stock`, { isInStock }), true));
}
if (context.writeScopes.has("messages:send")) {
  type SendArgs = IdArgs & { text: string; idempotencyKey: string; confirm: true };
  server.registerTool("send_message", { description: "Queue one text message to an existing conversation. Requires client approval and a stable idempotencyKey for retries.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { conversationId: z.string().uuid(), text: z.string().trim().min(1).max(65536), idempotencyKey: z.string().uuid(), confirm: confirmation } }, wrapped<SendArgs>("send_message", async ({ conversationId, text, idempotencyKey }) => {
    const summary = await api.get<{ data: { account_id: string } }>(`/conversations/${conversationId}/summary`);
    const accountId = summary.data?.account_id;
    if (!accountId || (context.accountId && accountId !== context.accountId)) throw new RelayApiError("account_forbidden", 403);
    const result = await api.write<{ messageId: string; status: string; deduplicated: boolean }>("POST", "/messages", { accountId, conversationId, clientMessageId: `mcp-${idempotencyKey}`, type: "text", text });
    return { messageId: result.messageId, status: result.status, deduplicated: result.deduplicated };
  }));
}

if (context.writeScopes.has("conversations:write")) {
  type UpdateArgs = IdArgs & { status?: "open" | "closed" | "archived"; favorite?: boolean; read?: boolean; unread?: boolean; customerStage?: string };
  server.registerTool("update_conversation", { description: "Update status, favorite, unread state or customer stage of a conversation.", annotations: { readOnlyHint: false, idempotentHint: true }, inputSchema: { conversationId: z.string().uuid(), status: z.enum(["open", "closed", "archived"]).optional(), favorite: z.boolean().optional(), read: z.literal(true).optional(), unread: z.literal(true).optional(), customerStage: z.enum(["new","considering","qualified","won","lost"]).optional() } }, wrapped<UpdateArgs>("update_conversation", ({ conversationId, ...fields }) => {
    if (!Object.keys(fields).length || (fields.read && fields.unread)) throw new RelayApiError("invalid_argument", 400);
    return api.write("PATCH", `/conversations/${conversationId}`, fields);
  }));
  type TagsArgs = IdArgs & { tagIds: string[]; confirm: true };
  server.registerTool("set_conversation_tags", { description: "Replace all tags on a conversation with exactly these tagIds, including an empty list to clear them. Requires client approval.", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: { conversationId: z.string().uuid(), tagIds: z.array(z.string().uuid()).max(20), confirm: confirmation } }, wrapped<TagsArgs>("set_conversation_tags", ({ conversationId, tagIds }) => api.write("PUT", `/conversations/${conversationId}/tags`, { tagIds })));
  type NoteArgs = IdArgs & { body: string; noteType?: "normal" | "order"; confirm: true };
  server.registerTool("add_conversation_note", { description: "Add a shared note to a conversation. Requires client approval.", annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }, inputSchema: { conversationId: z.string().uuid(), body: z.string().trim().min(1).max(5000), noteType: z.enum(["normal", "order"]).optional(), confirm: confirmation } }, wrapped<NoteArgs>("add_conversation_note", ({ conversationId, body, noteType }) => api.write("POST", `/conversations/${conversationId}/notes`, { body, noteType: noteType ?? "normal" })));
}

if (context.writeScopes.has("messages:send")) {
  type RetryArgs = { messageId: string; clientMessageId: string; confirm: true };
  server.registerTool("retry_message", { description: "Retry one failed or uncertain outgoing message with a stable idempotency key. Requires client approval.", annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, inputSchema: { messageId: z.string().uuid(), clientMessageId: z.string().min(8).max(128), confirm: confirmation } }, wrapped<RetryArgs>("retry_message", ({ messageId, clientMessageId }) => api.write("POST", `/messages/${messageId}/retry`, { clientMessageId })));
}

if (context.writeScopes.has("contacts:write")) {
  type ContactFields = { alias?: string; note?: string; firstName?: string; middleName?: string; lastName?: string; companyName?: string; jobTitle?: string };
  type UpdateContactArgs = { contactId: string } & ContactFields;
  server.registerTool("update_contact", { description: "Update selected contact name, company, alias or note fields without replacing emails and addresses.", annotations: { readOnlyHint: false, idempotentHint: true }, inputSchema: { contactId: z.string().uuid(), alias: z.string().trim().max(80).optional(), note: z.string().trim().max(5000).optional(), firstName: z.string().trim().max(80).optional(), middleName: z.string().trim().max(80).optional(), lastName: z.string().trim().max(80).optional(), companyName: z.string().trim().max(160).optional(), jobTitle: z.string().trim().max(160).optional() } }, wrapped<UpdateContactArgs>("update_contact", async ({ contactId, ...fields }) => {
    if (!Object.keys(fields).length) throw new RelayApiError("invalid_argument", 400);
    await api.write("PATCH", `/contacts/${contactId}/fields`, fields);
    return { contactId, updatedFields: Object.keys(fields) };
  }));
}

function encodeOffset(offset: number): string { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }
function decodeOffset(value: string): number { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { offset?: unknown }; if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error("invalid"); return Number(parsed.offset); } catch { throw new RelayApiError("invalid_argument", 400, "invalid contact cursor"); } }

await server.connect(new StdioServerTransport());
