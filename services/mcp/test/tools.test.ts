import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const serverFile = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const accountId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const conversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function connect(apiBaseUrl: string, writeScopes = "") {
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", serverFile], env: { ...process.env, RELAY_API_BASE_URL: apiBaseUrl, RELAY_API_KEY: "rdk_test_secret", RELAY_ACCOUNT_ID: accountId, RELAY_MCP_WRITE_SCOPES: writeScopes }, stderr: "pipe" });
  const client = new Client({ name: "relaydesk-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("stdio lists write tools only when enabled and sends with the bound account", async () => {
  const requests: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ method: req.method ?? "", url: req.url ?? "", body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {} });
    res.setHeader("content-type", "application/json");
    if (req.url?.includes("/summary")) res.end(JSON.stringify({ data: { account_id: accountId }, matches: true }));
    else if (req.url?.includes("/tags")) res.end(JSON.stringify({ data: [{ id: "tag-1" }, { id: "tag-2" }] }));
    else res.end(JSON.stringify({ messageId: "message-1", status: "queued", deduplicated: false }));
  });
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const readOnly = await connect(url);
    try {
      assert.equal((await readOnly.listTools()).tools.some(tool => tool.name === "send_message"), false);
      const operations = await readOnly.callTool({ name: "list_mcp_operations", arguments: {} });
      const operationRows = operations.structuredContent?.data as Array<{ name: string; enabled: boolean }>;
      assert.equal(operationRows.find(operation => operation.name === "send_message")?.enabled, false);
    } finally { await readOnly.close(); }

    const writable = await connect(url, "messages:send,conversations:write,contacts:write");
    try {
      const names = (await writable.listTools()).tools.map(tool => tool.name);
      assert.ok(names.includes("list_mcp_operations"));
      for (const name of ["send_message", "retry_message", "update_conversation", "set_conversation_tags", "add_conversation_note", "update_contact"]) assert.ok(names.includes(name));
      assert.ok(names.includes("list_tags"));
      const operations = await writable.callTool({ name: "list_mcp_operations", arguments: {} });
      const operationRows = operations.structuredContent?.data as Array<{ name: string; enabled: boolean }>;
      assert.equal(operationRows.find(operation => operation.name === "send_message")?.enabled, true);
      assert.equal(operationRows.find(operation => operation.name === "update_contact")?.enabled, true);
      assert.equal(operationRows.find(operation => operation.name === "retry_message")?.enabled, true);
      const missingConfirmation = await writable.callTool({ name: "send_message", arguments: { conversationId, text: "Hello", idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } });
      assert.equal(missingConfirmation.isError, true);
      assert.equal(requests.length, 0);
      const result = await writable.callTool({ name: "send_message", arguments: { conversationId, text: "Hello", idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", confirm: true } });
      assert.equal(result.isError, undefined);
      assert.equal((result.structuredContent?.data as { messageId: string }).messageId, "message-1");
      assert.equal(requests.length, 2);
      assert.equal(requests[1].method, "POST");
      assert.equal(new URL(requests[1].url, url).searchParams.get("accountId"), accountId);
      assert.deepEqual(requests[1].body, { accountId, conversationId, clientMessageId: "mcp-cccccccc-cccc-4ccc-8ccc-cccccccccccc", type: "text", text: "Hello" });

      const invalidUpdate = await writable.callTool({ name: "update_conversation", arguments: { conversationId } });
      assert.equal(invalidUpdate.isError, true);
      assert.equal(requests.length, 2);
      await writable.callTool({ name: "update_conversation", arguments: { conversationId, status: "closed" } });
      assert.equal(requests[2].method, "PATCH");
      assert.deepEqual(requests[2].body, { status: "closed" });

      const missingTagConfirmation = await writable.callTool({ name: "set_conversation_tags", arguments: { conversationId, tagIds: [] } });
      assert.equal(missingTagConfirmation.isError, true);
      assert.equal(requests.length, 3);
      await writable.callTool({ name: "set_conversation_tags", arguments: { conversationId, tagIds: [], confirm: true } });
      assert.equal(requests[3].method, "PUT");
      assert.deepEqual(requests[3].body, { tagIds: [] });

      const contactId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
      await writable.callTool({ name: "update_contact", arguments: { contactId, alias: "Jimmy" } });
      assert.equal(requests[4].method, "PATCH");
      assert.match(requests[4].url, new RegExp(`/contacts/${contactId}/fields`));
      assert.deepEqual(requests[4].body, { alias: "Jimmy" });
      for (const request of requests) assert.equal(new URL(request.url, url).searchParams.get("accountId"), accountId);
      const noteWithoutApproval = await writable.callTool({ name: "add_conversation_note", arguments: { conversationId, body: "Follow up" } });
      assert.equal(noteWithoutApproval.isError, true);
      assert.equal(requests.length, 5);
      await writable.callTool({ name: "add_conversation_note", arguments: { conversationId, body: "Follow up", confirm: true } });
      assert.equal(requests[5].method, "POST");
      assert.deepEqual(requests[5].body, { body: "Follow up", noteType: "normal" });
      const messageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const retryWithoutApproval = await writable.callTool({ name: "retry_message", arguments: { messageId, clientMessageId: "retry-12345678" } });
      assert.equal(retryWithoutApproval.isError, true);
      assert.equal(requests.length, 6);
      await writable.callTool({ name: "retry_message", arguments: { messageId, clientMessageId: "retry-12345678", confirm: true } });
      assert.equal(requests[6].method, "POST");
      assert.match(requests[6].url, new RegExp(`/messages/${messageId}/retry`));
      assert.equal(new URL(requests[6].url, url).searchParams.get("accountId"), accountId);
      assert.deepEqual(requests[6].body, { clientMessageId: "retry-12345678" });
      const firstTags = await writable.callTool({ name: "list_tags", arguments: { limit: 1 } });
      assert.deepEqual(firstTags.structuredContent?.data, [{ id: "tag-1" }]);
      const nextCursor = firstTags.structuredContent?.nextCursor;
      assert.equal(typeof nextCursor, "string");
      const secondTags = await writable.callTool({ name: "list_tags", arguments: { limit: 1, cursor: nextCursor } });
      assert.deepEqual(secondTags.structuredContent?.data, [{ id: "tag-2" }]);
    } finally { await writable.close(); }
  } finally { await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); }
});
