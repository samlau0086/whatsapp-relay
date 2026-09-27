import assert from "node:assert/strict";
import test from "node:test";
import {validateSameAccountMerge,type MergeIdentity} from "../src/same-account-merge.js";

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
