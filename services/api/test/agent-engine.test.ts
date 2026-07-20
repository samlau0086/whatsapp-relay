import assert from "node:assert/strict";
import test from "node:test";
import { chunkText, groundOrderNumberReply, isConversationAgentActive, isReplySourceCurrent, isWithinBusinessHours, passesAutoReplyGate, shouldAutoReply, type AgentDecision } from "../src/agent-engine.js";

test("chunkText creates bounded overlapping chunks",()=>{
  const input=("A paragraph with useful knowledge. ").repeat(120);
  const chunks=chunkText(input,300,40);
  assert.ok(chunks.length>2);
  assert.ok(chunks.every(chunk=>chunk.length<=300));
});

test("automatic replies require confidence and valid citations",()=>{
  const decision:AgentDecision={decision:"auto_reply",reply:"Our warranty is 12 months.",confidence:.9,citations:["chunk-1"],reason:"documented"};
  assert.equal(passesAutoReplyGate(decision,.8,new Set(["chunk-1"])),true);
  assert.equal(passesAutoReplyGate({...decision,citations:["missing"]},.8,new Set(["chunk-1"])),false);
  assert.equal(passesAutoReplyGate({...decision,confidence:.7},.8,new Set(["chunk-1"])),false);
  assert.equal(passesAutoReplyGate({...decision,reply:"We will refund your payment."},.8,new Set(["chunk-1"])),false);
});

test("business hours use the configured timezone and weekdays",()=>{
  const mondayUtc=new Date("2026-07-20T02:30:00.000Z");
  assert.equal(isWithinBusinessHours(mondayUtc,"Asia/Shanghai",[1,2,3,4,5],"09:00","18:00"),true);
  assert.equal(isWithinBusinessHours(mondayUtc,"Asia/Shanghai",[0,6],"09:00","18:00"),false);
});

test("automatic replies require per-conversation AI takeover",()=>{
  assert.equal(isConversationAgentActive(true,"cautious"),true);
  assert.equal(isConversationAgentActive(true,"full"),true);
  assert.equal(isConversationAgentActive(true,"human_paused"),false);
  assert.equal(isConversationAgentActive(true,null),false);
  assert.equal(isConversationAgentActive(false,"full"),false);
});

test("full takeover sends useful replies without the cautious evidence gate",()=>{
  const uncertain:AgentDecision={decision:"draft",reply:"I can help you check that.",confidence:.2,citations:[],reason:"limited evidence"};
  assert.equal(shouldAutoReply(uncertain,"cautious",.8,new Set()),false);
  assert.equal(shouldAutoReply(uncertain,"full",.8,new Set()),true);
  assert.equal(shouldAutoReply({...uncertain,decision:"ignore"},"full",.8,new Set()),false);
});

test("agent decisions can carry a Chinese review translation",()=>{
  const decision:AgentDecision={decision:"draft",reply:"How can I help?",replyZh:"请问有什么可以帮助您？",confidence:.5,citations:[],reason:"review"};
  assert.equal(decision.replyZh,"请问有什么可以帮助您？");
});

test("late reply jobs cannot answer a newer customer message",()=>{
  assert.equal(isReplySourceCurrent("reply","message-old","message-new"),false);
  assert.equal(isReplySourceCurrent("reply","message-new","message-new"),true);
  assert.equal(isReplySourceCurrent("followup","message-old","message-new"),true);
});

test("order-number questions are grounded in the latest conversation order",()=>{
  const wrong:AgentDecision={decision:"auto_reply",reply:"Our company name is unavailable.",replyZh:"无法确认公司名称。",confidence:.9,citations:[],reason:"wrong topic"};
  const grounded=groundOrderNumberReply(wrong,"send me the order number",[{order_number:"20260720003"}]);
  assert.equal(grounded.reply,"Order #20260720003");
  assert.equal(grounded.replyZh,"订单号：20260720003");
  assert.equal(groundOrderNumberReply(wrong,"what is your company name?",[{order_number:"20260720003"}]),wrong);
});
