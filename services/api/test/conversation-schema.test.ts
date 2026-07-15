import assert from "node:assert/strict";
import test from "node:test";
import { newConversationSchema } from "../src/schemas.js";

const accountId="10000000-0000-4000-8000-000000000009";

test("new conversation normalizes a single international phone number",()=>{
  const parsed=newConversationSchema.parse({accountId,phone:"+86 138-0013-8000",displayName:" 客户 ",firstMessage:" 您好 ",clientMessageId:"new-chat-001"});
  assert.equal(parsed.phone,"8613800138000");
  assert.equal(parsed.displayName,"客户");
  assert.equal(parsed.firstMessage,"您好");
});

test("new conversation rejects local or empty destinations",()=>{
  assert.equal(newConversationSchema.safeParse({accountId,phone:"0138000",firstMessage:"您好",clientMessageId:"new-chat-002"}).success,false);
  assert.equal(newConversationSchema.safeParse({accountId,phone:"+8613800138000",firstMessage:" ",clientMessageId:"new-chat-003"}).success,false);
});
