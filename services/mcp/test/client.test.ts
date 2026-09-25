import test from "node:test";
import assert from "node:assert/strict";
import { RelayApiClient, RelayApiError } from "../src/relay-api-client.js";

test("RelayApiClient binds every request to the configured account", async () => {
  let seen = "";
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "rdk_secret", accountId: "account-1", writeScopes: new Set() }, async (input, init) => {
    seen = `${input}${(init?.headers as Record<string, string>).authorization}`;
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  await client.get("/contacts", { q: "alice" });
  assert.match(seen, /accountId=account-1/);
  assert.match(seen, /Bearer rdk_secret/);
});

test("RelayApiClient binds write requests and never lets parameters override the account", async () => {
  let seenUrl = "";
  let seenBody = "";
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "rdk_secret", accountId: "account-1", writeScopes: new Set() }, async (input, init) => {
    seenUrl = String(input);
    seenBody = String(init?.body);
    if (init?.method === "PATCH") assert.equal((init?.headers as Record<string, string>)["content-type"], "application/json");
    return new Response(JSON.stringify({ id: "contact-1" }), { status: 200 });
  });
  await client.get("/contacts", { accountId: "account-2" });
  assert.equal(new URL(seenUrl).searchParams.get("accountId"), "account-1");
  await client.write("PATCH", "/contacts/contact-1/fields", { alias: "Jimmy" });
  assert.equal(new URL(seenUrl).searchParams.get("accountId"), "account-1");
  assert.deepEqual(JSON.parse(seenBody), { alias: "Jimmy" });
});

test("RelayApiClient maps upstream authorization failures", async () => {
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "bad", accountId: "account-1", writeScopes: new Set() }, async () => new Response(JSON.stringify({ error: "invalid_api_key" }), { status: 401 }));
  await assert.rejects(client.get("/contacts"), (error: unknown) => error instanceof RelayApiError && error.code === "unauthorized");
});

test("RelayApiClient maps timeout and network errors", async () => {
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "bad", accountId: "account-1", writeScopes: new Set() }, async () => { throw new Error("offline"); });
  await assert.rejects(client.get("/contacts"), (error: unknown) => error instanceof RelayApiError && error.code === "upstream_unavailable" && /Cannot connect/.test(error.message) && !error.message.includes("bad"));
});

test("RelayApiClient rejects HTML from a misconfigured API base URL", async () => {
  const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "rdk_secret", accountId: null, writeScopes: new Set() }, async () => new Response("<html>Web app</html>", { status: 200 }));
  await assert.rejects(client.get("/contacts"), (error: unknown) => error instanceof RelayApiError && error.code === "upstream_unavailable" && /non-JSON response/.test(error.message) && !error.message.includes("Web app"));
});

test("RelayApiClient reports HTTP failures without leaking upstream response bodies", async () => {
  for (const [status, code] of [[403, "account_forbidden"], [404, "not_found"], [429, "rate_limited"], [500, "upstream_unavailable"]] as const) {
    const client = new RelayApiClient({ apiBaseUrl: "https://relay.test", apiKey: "rdk_secret", accountId: null, writeScopes: new Set() }, async () => new Response("private upstream details", { status }));
    await assert.rejects(client.get("/contacts"), (error: unknown) => error instanceof RelayApiError && error.code === code && error.status === status && error.message === `Relay API returned HTTP ${status}`);
  }
});
