import test from "node:test";
import assert from "node:assert/strict";
import { apiKeyCreateSchema, contactFieldsSchema } from "../src/schemas.js";

test("API keys may request explicit MCP write scopes", () => {
  const parsed = apiKeyCreateSchema.parse({ name: "MCP", scopes: ["messages:send", "conversations:write", "contacts:write"] });
  assert.equal(parsed.scopes.length, 3);
  assert.equal(apiKeyCreateSchema.safeParse({ name: "MCP", scopes: ["messages:send", "messages:send"] }).success, false);
});

test("contact field updates accept only a nonempty, limited patch", () => {
  assert.deepEqual(contactFieldsSchema.parse({ alias: "Jimmy" }), { alias: "Jimmy" });
  assert.equal(contactFieldsSchema.safeParse({}).success, false);
  assert.equal(contactFieldsSchema.safeParse({ phone: "+123456789" }).success, false);
});
