import assert from "node:assert/strict";
import test from "node:test";
import {isHolidayBlocked,nextDailyProactiveRunAt,nextEligibleProactiveRunAt,normalizeProactiveMessageTemplates,renderProactiveMessageTemplate,resolveProactiveLanguage,selectProactiveMessageTemplate} from "../src/proactive-outreach.js";

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
