import assert from "node:assert/strict";
import test from "node:test";
import { isTransientDatabaseStartupError, retryDatabaseStartup } from "../src/database-startup-retry.js";

test("database startup retries transient connection failures",async()=>{
  let calls=0;
  const result=await retryDatabaseStartup(async()=>{
    calls++;
    if(calls<3)throw Object.assign(new Error("database restarting"),{code:"ECONNREFUSED"});
    return "ready";
  },{attempts:3,baseDelayMs:1,sleep:async()=>undefined});
  assert.equal(result,"ready");
  assert.equal(calls,3);
  assert.equal(isTransientDatabaseStartupError({cause:{code:"57P03"}}),true);
});

test("database startup does not retry migration errors",async()=>{
  let calls=0;
  await assert.rejects(()=>retryDatabaseStartup(async()=>{calls++;throw Object.assign(new Error("bad migration"),{code:"42601"});},{sleep:async()=>undefined}),/bad migration/);
  assert.equal(calls,1);
});
