import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source=await readFile(new URL("../app/conversation-modes.ts",import.meta.url),"utf8");
const javascript=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText;
const {initialConversationMode,modeMembers,matchesMessageMode}=await import(`data:text/javascript,${encodeURIComponent(javascript)}`);

test("原始会话类型不随 Email 或 WhatsApp 资料修改而变化",()=>{
  assert.equal(initialConversationMode({originMode:"email",platform:"whatsapp",phone:"+1234567890"}),"email");
  assert.equal(initialConversationMode({originMode:"livechat",platform:"livechat",primaryEmail:"a@example.com"}),"livechat");
  assert.equal(initialConversationMode({platform:"whatsapp",primaryEmail:"a@example.com"}),"email");
  assert.equal(initialConversationMode({platform:"whatsapp",whatsappUsername:"alice",primaryEmail:"a@example.com"}),"whatsapp");
});

test("Email 需要客户邮箱及渠道 Provider 或会话邮箱，其他模式按原始成员隔离",()=>{
  const members=[{id:"email",mode:"email",primaryEmail:"a@example.com",hasEmailProvider:true},{id:"livechat",mode:"livechat",primaryEmail:"b@example.com",hasMailbox:true},{id:"whatsapp",mode:"whatsapp",primaryEmail:"c@example.com"},{id:"no-email",mode:"livechat",hasMailbox:true}];
  assert.deepEqual(modeMembers(members,"email").map(item=>item.id),["email","livechat"]);
  assert.deepEqual(modeMembers(members,"whatsapp").map(item=>item.id),["whatsapp"]);
  assert.deepEqual(modeMembers(members,"livechat").map(item=>item.id),["livechat","no-email"]);
});

test("同一渠道产生的 Email 不出现在 WhatsApp 或 Live Chat 模式中",()=>{
  const messages=[{id:"wa",platform:"whatsapp"},{id:"lc",platform:"livechat"},{id:"email-wa",platform:"whatsapp",email:{subject:""}},{id:"email-lc",platform:"livechat",email:{subject:"主题"}}];
  assert.deepEqual(messages.filter(item=>matchesMessageMode(item,"email")).map(item=>item.id),["email-wa","email-lc"]);
  assert.deepEqual(messages.filter(item=>matchesMessageMode(item,"whatsapp")).map(item=>item.id),["wa"]);
  assert.deepEqual(messages.filter(item=>matchesMessageMode(item,"livechat")).map(item=>item.id),["lc"]);
});

test("Live Chat 映射的邮件仅启用 Email，合并真实访客后才可回复 Live Chat",()=>{
  const email={id:"mail",originMode:"email",platform:"livechat",primaryEmail:"a@example.com",hasEmailProvider:true};
  const member={...email,mode:initialConversationMode(email)};
  assert.equal(member.mode,"email");
  assert.deepEqual(modeMembers([member],"livechat"),[]);
  assert.deepEqual(modeMembers([member],"email").map(item=>item.id),["mail"]);
  const visitor={id:"visitor",mode:"livechat",platform:"livechat"};
  assert.deepEqual(modeMembers([member,visitor],"livechat").map(item=>item.id),["visitor"]);
});
