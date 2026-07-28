import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loginSchema } from "../src/schemas.js";

test("login accepts an explicit persistent-session choice",()=>{
  assert.equal(loginSchema.parse({email:"agent@example.com",password:"secret"}).rememberMe,false);
  assert.equal(loginSchema.parse({email:"agent@example.com",password:"secret",rememberMe:true}).rememberMe,true);
});

test("persistent sessions are stored and included in startup migrations",async()=>{
  const [migration,migrator,server]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/051_persistent_login.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS persistent boolean NOT NULL DEFAULT false/);
  assert.match(migrator,/051_persistent_login\.sql/);
  assert.match(server,/Max-Age=34560000/);
  assert.match(server,/r\.persistent/);
});
