import test from "node:test";
import assert from "node:assert/strict";
import { RelayApiClient, RelayApiError } from "../src/relay-api-client.js";

test("RelayApiClient binds every request to the configured account", async () => {
  let seen = "";
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "rdk_secret", accountId: "account-1" }, async (input, init) => {
    seen = `${input}${(init?.headers as Record<string, string>).authorization}`;
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await client.get("/contacts", { q: "alice" });
  assert.match(seen, /accountId=account-1/);
  assert.match(seen, /Bearer rdk_secret/);
});

test("RelayApiClient maps upstream authorization failures", async () => {
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "bad", accountId: "account-1" }, async () => new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 401 }));
  await assert.rejects(client.get("/contacts"), (error: unknown) => error instanceof RelayApiError && error.code === "unauthorized");
});

test("RelayApiClient maps timeout and network errors", async () => {
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "bad", accountId: "account-1" }, async () => { throw new Error("offline"); });
  await assert.rejects(client.get("/contacts"), (error: unknown) => error instanceof RelayApiError && error.code === "upstream_unavailable");
});
