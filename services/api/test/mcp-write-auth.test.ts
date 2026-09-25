import test from "node:test";
import assert from "node:assert/strict";
import { canAccessAccount, hasScope, type Principal } from "../src/auth.js";

test("write scopes and account limits remain separate for API keys", () => {
  const principal: Principal = { kind: "api_key", id: "key-1", scopes: ["messages:send"], accountIds: ["account-1"] };
  assert.equal(hasScope(principal, "messages:send"), true);
  assert.equal(hasScope(principal, "contacts:write"), false);
  assert.equal(hasScope(principal, "conversations:write"), false);
  assert.equal(canAccessAccount(principal, "account-1"), true);
  assert.equal(canAccessAccount(principal, "account-2"), false);
});
