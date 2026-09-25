import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { audit } from "./audit.js";
import { loadContext } from "./context.js";
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
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message: code }, requestId }) }] };
    }
  };
}

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
  return { ...body, nextCursor: body.hasMore ? encodeOffset(body.nextOffset) : null };
}));
server.registerTool("get_contact", { description: "Get a contact profile by ID.", inputSchema: { contactId: z.string().uuid() } }, wrapped<{ contactId: string }>("get_contact", ({ contactId }) => api.get(`/contacts/${contactId}`)));

type GroupArgs = { limit: number; cursor?: string };
server.registerTool("list_whatsapp_groups", { description: "List WhatsApp group conversations in the bound account.", inputSchema: { limit: pageSize, cursor } }, wrapped<GroupArgs>("list_whatsapp_groups", ({ limit, cursor }) => api.get("/conversations", { filter: "groups", limit, cursor })));
server.registerTool("get_conversation_details", { description: "Get tags, notes, reminder and order details for a conversation.", inputSchema: { conversationId: z.string().uuid() } }, wrapped<IdArgs>("get_conversation_details", ({ conversationId }) => api.get(`/conversations/${conversationId}/details`)));

function encodeOffset(offset: number): string { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }
function decodeOffset(value: string): number { try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { offset?: unknown }; if (!Number.isInteger(parsed.offset) || Number(parsed.offset) < 0) throw new Error("invalid"); return Number(parsed.offset); } catch { throw new RelayApiError("invalid_argument", 400, "invalid contact cursor"); } }

await server.connect(new StdioServerTransport());
