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

function wrapped<TArgs>(tool: string, handler: (args: TArgs) => Promise<unknown>) {
  return async (args: TArgs) => {
    const requestId = randomUUID();
    const started = Date.now();
    try {
      const data = await handler(args);
      const body = data && typeof data === "object" && "data" in data ? data as { data: unknown; nextCursor?: unknown; total?: unknown; hasMore?: unknown } : { data };
      const output = body.data;
      const count = Array.isArray(output) ? output.length : undefined;
      const nextCursor = body.nextCursor ?? null;
      const payload = { data: output, meta: { accountScope: context.accountId ?? "all", ...(body.total === undefined ? {} : { total: body.total }), ...(body.hasMore === undefined ? {} : { hasMore: body.hasMore }) }, nextCursor, requestId };
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
  { name: "send_message", mode: "write", scope: "messages:send", description: "发送单条文本消息" },
  { name: "update_conversation", mode: "write", scope: "conversations:write", description: "更新会话状态、收藏、已读状态或客户阶段" },
  { name: "set_conversation_tags", mode: "write", scope: "conversations:write", description: "整体替换会话标签" },
  { name: "update_contact", mode: "write", scope: "contacts:write", description: "更新联系人有限资料字段" },
] as const;

server.registerTool("list_mcp_operations", {
  description: "List all RelayDesk MCP operations, including disabled write operations and the scope required to enable them.",
  inputSchema: {},
}, wrapped<Record<string, never>>("list_mcp_operations", async () => ({
  data: operationCatalog.map(operation => ({
    ...operation,
    enabled: operation.scope === null || context.writeScopes.has(operation.scope as typeof WRITE_SCOPES[number]),
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

const confirmation = z.literal(true).describe("Set only after approving this exact operation in the MCP client.");
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
