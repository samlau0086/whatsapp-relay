import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {isHolidayBlocked,nextDailyProactiveRunAt,nextEligibleProactiveRunAt,normalizeProactiveMessageTemplates,proactiveTemplateScenario,renderProactiveMessageTemplate,resolveProactiveLanguage,selectProactiveMessageTemplate} from "../src/proactive-outreach.js";

const holidays={global:[{id:"christmas",name:"圣诞节",month:12,day:25,regions:["global"]}]};

test("proactive reply language prefers contact settings",()=>{
  assert.equal(resolveProactiveLanguage("auto","en_US"),"en_US");
  assert.equal(resolveProactiveLanguage("zh_TW","en_US"),"zh_TW");
});

test("holiday blocking skips weekends and configured holidays",()=>{
  assert.equal(isHolidayBlocked(new Date("2026-12-25T10:00:00+08:00"),"Asia/Shanghai",holidays,"CN").blocked,true);
  assert.equal(isHolidayBlocked(new Date("2026-12-26T10:00:00+08:00"),"Asia/Shanghai",holidays,"CN").blocked,true);
  assert.equal(isHolidayBlocked(new Date("2026-12-24T10:00:00+08:00"),"Asia/Shanghai",holidays,"CN").blocked,false);
});

test("next eligible run moves to the next business day",()=>{
  const next=nextEligibleProactiveRunAt(new Date("2026-12-25T10:00:00+08:00"),"Asia/Shanghai","10:00","17:00",holidays,"CN");
  assert.ok(next.getTime()>new Date("2026-12-25T10:00:00+08:00").getTime());
});

test("daily limit defers work until the next eligible day",()=>{
  const now=new Date("2026-12-24T16:30:00+08:00"),next=nextDailyProactiveRunAt(now,"Asia/Shanghai","10:00","17:00",holidays,"CN");
  assert.ok(next.getTime()>new Date("2026-12-25T00:00:00+08:00").getTime());
});

test("system templates prefer customer language and render supported variables",()=>{
  const templates={default:"Hi {{contactName}}, just checking in.",zh_CN:{id:"zh-followup",body:"{{contactName}}，想确认您是否还需要协助？"}};
  const selected=selectProactiveMessageTemplate(templates,"zh_CN");
  assert.equal(selected?.id,"zh-followup");
  assert.equal(renderProactiveMessageTemplate(selected!,{contactName:"王女士",companyName:"示例公司",customerStage:"new"}),"王女士，想确认您是否还需要协助？");
  assert.deepEqual(normalizeProactiveMessageTemplates(templates).map(template=>template.language),[undefined,"zh_CN"]);
});

test("system templates match touch scenario and customer stage before language fallback",()=>{
  const templates={templates:[
    {id:"new-first",scenario:"first_touch",customerStages:["new"],body:"Welcome {{contactName}}"},
    {id:"qualified-first",scenario:"first_touch",customerStages:["qualified"],body:"Ready to help {{contactName}}"},
    {id:"follow-default",scenario:"follow_up",body:"Following up {{contactName}}"},
    {id:"follow-zh",language:"zh_CN",scenario:"follow_up",body:"{{contactName}}，想确认您是否还需要协助？"},
  ]};
  assert.equal(proactiveTemplateScenario(0),"first_touch");
  assert.equal(proactiveTemplateScenario(1),"follow_up");
  assert.equal(selectProactiveMessageTemplate(templates,"en","first_touch","qualified")?.id,"qualified-first");
  assert.equal(selectProactiveMessageTemplate(templates,"zh_CN","follow_up","new")?.id,"follow-zh");
  assert.equal(selectProactiveMessageTemplate(templates,"en","follow_up","new")?.id,"follow-default");
});

test("proactive outreach queries use the existing contact country field",async()=>{
  const source=await readFile(new URL("../src/proactive-outreach.ts",import.meta.url),"utf8");
  assert.doesNotMatch(source,/\bc(?:o)?\.country_code\b/);
  assert.match(source,/\bc\.country country_code\b/);
  assert.match(source,/\bco\.country country_code\b/);
});

test("proactive outreach locks only nullable-safe tables",async()=>{
  const source=await readFile(new URL("../src/proactive-outreach.ts",import.meta.url),"utf8");
  assert.match(source,/ORDER BY j\.planned_at FOR UPDATE OF j SKIP LOCKED LIMIT 1/);
  assert.match(source,/WHERE c\.id=\$1 FOR UPDATE OF c,cv/);
  assert.doesNotMatch(source,/ORDER BY j\.planned_at FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(source,/WHERE c\.id=\$1 FOR UPDATE[",`]/);
});

test("proactive outreach upgrades legacy tables before saving settings or deferring jobs",async()=>{
  const source=await readFile(new URL("../src/proactive-outreach.ts",import.meta.url),"utf8");
  assert.match(source,/ALTER TABLE proactive_outreach_settings ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(source,/ALTER TABLE proactive_outreach_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now\(\)/);
});

test("deferred outreach preserves the PostgreSQL timestamp parameter",async()=>{
  const source=await readFile(new URL("../src/proactive-outreach.ts",import.meta.url),"utf8");
  assert.match(source,/"skipped",reason,job\.planned_at as Date,metadata/);
  assert.doesNotMatch(source,/String\(job\.planned_at\)/);
});

test("manual outreach scan bypasses the background scan throttle",async()=>{
  const [source,routes]=await Promise.all([
    readFile(new URL("../src/proactive-outreach.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/proactive-routes.ts",import.meta.url),"utf8"),
  ]);
  assert.match(source,/scanProactiveOutreach\(force=false\)/);
  assert.match(source,/if\(!force&&Date\.now\(\)-lastScan<60_000\)return/);
  assert.match(routes,/proactive-outreach\/scan[\s\S]*?scanProactiveOutreach\(true\)/);
});

test("superseded approval drafts cannot reappear or be sent again",async()=>{
  const source=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const staleGuard=/NOT EXISTS \(SELECT 1 FROM messages m WHERE m\.conversation_id=d\.conversation_id AND m\.direction='out' AND m\.status IN \('queued','dispatching','sent','delivered','read'\) AND \(m\.occurred_at>=d\.created_at OR .*m\.text_content.*d\.text_content/;
  const readRoute=source.slice(source.indexOf('app.get("/api/v1/conversations/:id/agent"'),source.indexOf('app.post("/api/v1/conversations/:id/reply-suggestion"'));
  const sendRoute=source.slice(source.indexOf('app.post("/api/v1/ai-drafts/:id/send"'),source.indexOf('app.post("/api/v1/ai-drafts/:id/dismiss"'));
  assert.match(source,staleGuard);
  assert.match(source,/m\.occurred_at>=d\.created_at-interval '7 days' AND EXISTS \(SELECT 1 FROM proactive_outreach_jobs pj WHERE pj\.payload->>'draftId'=d\.id::text\)/);
  assert.match(readRoute,/\$\{currentDraftGuard\}/);
  assert.match(sendRoute,/\$\{currentDraftGuard\} FOR UPDATE OF d/);
  assert.match(sendRoute,/proactive_outreach_events\(account_id,contact_id,job_id,event_type,reason,planned_at\).*'sent','human_approved'/);
});

test("outreach cadence counts confirmed messages including human-approved drafts",async()=>{
  const source=await readFile(new URL("../src/proactive-outreach.ts",import.meta.url),"utf8");
  assert.equal((source.match(/proactive_outreach_jobs sent_job JOIN messages sent_message/g)??[]).length,2);
  assert.match(source,/sent_job\.state='sent' AND sent_message\.status IN \('sent','delivered','read'\)/);
  assert.match(source,/state IN \('pending','processing','awaiting_approval'\)/);
  assert.match(source,/Number\(state\.touches\)>Number\(\(job\.payload/);
  assert.match(source,/state\.last_contact_at.*proactiveCadenceDays\(Number\(state\.touches\)\)\*DAY/);
  assert.match(source,/const duplicate=await client\.query\("SELECT 1 FROM messages WHERE conversation_id=\$1 AND direction='out'.*regexp_replace\(lower\(btrim\(text_content\)\).*LIMIT 1"/);
  assert.match(source,/if\(duplicate\.rowCount\).*last_error='already_sent'/);
  assert.match(source,/SELECT d\.id FROM ai_drafts d JOIN proactive_outreach_jobs pj.*pj\.state='awaiting_approval'.*m\.occurred_at>=d\.created_at-interval '7 days'.*FOR UPDATE OF d/);
  assert.match(source,/UPDATE ai_drafts SET status='dismissed'.*id=ANY\(\$1::uuid\[\]\)/);
  assert.match(source,/UPDATE proactive_outreach_jobs SET state='skipped'.*last_error='draft_superseded'.*payload->>'draftId'=ANY\(\$1::text\[\]\)/);
});
