import assert from "node:assert/strict";
import test from "node:test";
import type {PoolClient} from "pg";
import {resolveSameAccountRuleConflicts,validateSameAccountMerge,type MergeIdentity} from "../src/same-account-merge.js";

const source:MergeIdentity={id:"source",account_id:"account",contact_id:"source-contact",provider_user_id:"123456789@lid",phone_e164:null,whatsapp_username:"customer",entity_type:"person",platform:"whatsapp",transport:"web"};
const target:MergeIdentity={...source,id:"target",contact_id:"target-contact",provider_user_id:null};

test("username-only main conversation may adopt the reply LID",()=>{
  assert.equal(validateSameAccountMerge(source,target),null);
});

test("rejects distinct accounts and different known identities",()=>{
  assert.match(validateSameAccountMerge(source,{...target,account_id:"another"})??"",/同一账号/);
  assert.match(validateSameAccountMerge(source,{...target,provider_user_id:"987654321@lid"})??"",/不同的 WhatsApp 身份/);
  assert.match(validateSameAccountMerge(source,{...target,whatsapp_username:"another"})??"",/用户名不同/);
  assert.match(validateSameAccountMerge({...source,phone_e164:"+123456789"},{...target,phone_e164:"+987654321"})??"",/手机号不同/);
});

test("requires a real source JID and a person-to-person WhatsApp Web conversation",()=>{
  assert.match(validateSameAccountMerge({...source,provider_user_id:null},target)??"",/缺少可用/);
  assert.match(validateSameAccountMerge({...source,entity_type:"group"},target)??"",/单人会话/);
  assert.match(validateSameAccountMerge({...source,transport:"cloud"},target)??"",/WhatsApp Web/);
  assert.match(validateSameAccountMerge(source,{...target,id:source.id})??"",/另一条会话/);
});

test("duplicate rules cancel unfinished source tasks and retain disabled historical rules",async()=>{
  const statements:Array<{sql:string;params:unknown[]}>=[];
  const client={query:async(sql:string,params:unknown[])=>{
    statements.push({sql,params});
    return{rowCount:statements.length===1?2:1};
  }} as unknown as PoolClient;
  assert.deepEqual(await resolveSameAccountRuleConflicts(client,"source-contact","target-contact"),{cancelledTasks:2,detachedRules:1});
  assert.equal(statements.length,2);
  assert.match(statements[0].sql,/UPDATE tasks SET status='cancelled'/);
  assert.match(statements[0].sql,/WHERE rule_id IN \(SELECT s.id FROM task_rules s JOIN task_rules t/);
  assert.match(statements[0].sql,/status IN \('planned','in_progress','waiting_approval','scheduled','overdue'\)/);
  assert.match(statements[1].sql,/UPDATE task_rules SET contact_id=NULL,enabled=false/);
  assert.deepEqual(statements.map(item=>item.params),[["source-contact","target-contact"],["source-contact","target-contact"]]);
});
