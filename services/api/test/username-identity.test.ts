import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PoolClient } from "pg";
import { matchUsernameContact } from "../src/agent-hub.js";

test("unique username binds a new LID to the existing contact",async()=>{
  const calls:Array<{sql:string;values:unknown[]}>=[];
  const client={query:async(sql:string,values:unknown[])=>{
    calls.push({sql,values});
    if(sql.includes("whatsapp_username=$2 ORDER BY"))return{rowCount:1,rows:[{id:"old",provider_user_id:null}]};
    if(sql.includes("provider_user_id=$2 AND id<>$3"))return{rowCount:0,rows:[]};
    return{rowCount:1,rows:[]};
  }} as unknown as PoolClient;
  assert.equal(await matchUsernameContact(client,"account","123456789@lid","user.name"),"old");
  assert.equal(calls.length,3);
  assert.deepEqual(calls[2].values,["old","123456789@lid"]);
});

test("ambiguous usernames and occupied JIDs never rebind contacts",async()=>{
  for(const scenario of ["ambiguous","occupied","different"]){
    let updates=0;
    const client={query:async(sql:string)=>{
      if(sql.startsWith("UPDATE"))updates++;
      if(sql.includes("whatsapp_username=$2 ORDER BY"))return scenario==="ambiguous"?{rowCount:2,rows:[{id:"old"},{id:"other"}]}:{rowCount:1,rows:[{id:"old",provider_user_id:scenario==="different"?"987654321@lid":null}]};
      return{rowCount:1,rows:[{id:"other"}]};
    }} as unknown as PoolClient;
    assert.equal(await matchUsernameContact(client,"account","123456789@lid","user.name"),null);
    assert.equal(updates,0);
  }
});

test("worker forwards username mappings for phone and LID contacts",async()=>{
  const worker=await readFile(new URL("../../../apps/agent/src/account-worker.ts",import.meta.url),"utf8");
  assert.match(worker,/jid\.endsWith\("@s\.whatsapp\.net"\)\|\|jid\.endsWith\("@lid"\)/);
  assert.match(worker,/emitContactUsername\(init\.accountId,\{id:toJid,username:toUsername\}\)/);
});

test("inbound username routing precedes JID merge and rejects conflicting username copies",async()=>{
  const hub=await readFile(new URL("../src/agent-hub.ts",import.meta.url),"utf8");
  const inbound=hub.slice(hub.indexOf("export async function ingestNormalizedMessage"));
  assert.ok(inbound.indexOf("const usernameContactId=")<inbound.indexOf("const mergedContactId="));
  assert.match(inbound,/const existingLid=.*provider_user_id=\$2 AND id<>\$3/);
  assert.match(inbound,/const safeUsername=usernameConflict\?\.rowCount\?"":remoteUsername/);
});
