import test from "node:test";
import assert from "node:assert/strict";
import { loadContext } from "../src/context.js";

test("loadContext requires a fixed API key and account", () => {
  assert.throws(() => loadContext({ RELAY_API_BASE_URL: "https://relay.test" }), /RELAY_API_KEY/);
  assert.throws(() => loadContext({ RELAY_API_KEY: "rdk_key" }), /RELAY_ACCOUNT_ID/);
  assert.deepEqual(loadContext({ RELAY_API_BASE_URL: "https://relay.test/", RELAY_API_KEY: "rdk_key", RELAY_ACCOUNT_ID: "account-1" }), { apiBaseUrl: "https://relay.test", apiKey: "rdk_key", accountId: "account-1", writeScopes: new Set() });
  assert.deepEqual(loadContext({ RELAY_API_KEY: "rdk_key", RELAY_ACCOUNT_ID: "all", RELAY_MCP_WRITE_SCOPES: "messages:send, contacts:write" }), { apiBaseUrl: "http://localhost:8080", apiKey: "rdk_key", accountId: null, writeScopes: new Set(["messages:send", "contacts:write"]) });
  assert.throws(() => loadContext({ RELAY_API_KEY: "rdk_key", RELAY_ACCOUNT_ID: "all", RELAY_MCP_WRITE_SCOPES: "admin:all" }), /unsupported scope/);
});
