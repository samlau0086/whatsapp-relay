import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manual reply suggestion combines conversation context and assigned knowledge", async () => {
  const [engine, server, ui] = await Promise.all([
    readFile(new URL("../src/agent-engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../../../app/whatsapp-inbox.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(engine, /export async function generateSalesReplySuggestion/);
  assert.match(engine, /retrieveKnowledge\(\s*provider,\s*cfg\.account_id/);
  assert.match(engine, /customer_memory_facts/);
  assert.match(engine, /JOIN contacts co ON co\.id=c\.contact_id/);
  assert.match(engine, /customerProfile/);
  assert.match(engine, /including the known customer name/);
  assert.match(engine, /fake urgency, pressure, unsupported discounts/);
  assert.match(engine, /auditable decision summary, not hidden chain-of-thought/);
  assert.match(engine, /translateReviewAnalysisToChinese/);
  assert.match(engine, /Simplified Chinese only/);
  assert.match(engine, /This is a rethink request/);
  assert.match(engine, /buildReplyTimingContext/);
  assert.match(engine, /hoursSinceLastContact/);
  assert.match(engine, /conversationState\.currentTime and replyTiming as authoritative time context/);
  assert.match(engine, /follow_up_after_business_message/);
  assert.match(engine, /Relative promises such as "tomorrow"/);
  assert.match(engine, /follow conversationState\.requiredAction instead of blindly answering latestCustomerMessage/);
  assert.match(engine, /reply_suggestion_instructions/);
  assert.match(engine, /retrieveProducts/);
  assert.match(engine, /extractProductSkuCandidates/);
  assert.match(engine, /productCatalog/);
  assert.match(engine, /product_price_tiers/);
  assert.match(server, /\/api\/v1\/conversations\/:id\/reply-suggestion/);
  assert.match(server, /reply_suggestion_instructions/);
  assert.match(ui, /回复建议 Agent/);
  assert.match(ui, /自动考虑距上次联系的时间/);
  assert.match(ui, /专属策略（可选）/);
  assert.match(ui, /Agent 分析说明/);
  assert.match(ui, /重新思考/);
  assert.match(ui, /JSON\.stringify\(\{previousReply\}\)/);
  assert.match(ui, /setDraft\(replySuggestion\.reply\)/);
});
