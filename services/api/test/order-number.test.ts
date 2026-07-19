import assert from "node:assert/strict";
import test from "node:test";
import { businessDate, formatOrderNumber, isValidTimeZone, validateOrderNumberTemplate } from "../src/order-number.js";

test("formats required order number variables and sequence width",()=>{
  const date=new Date("2026-07-19T16:30:00Z");
  assert.equal(formatOrderNumber("SO-{YYYY}{MM}{DD}-{SEQ:4}",date,"Asia/Shanghai",27),"SO-20260720-0027");
  assert.equal(formatOrderNumber("{YY}/{MM}/{DD}/{SEQ:1}",date,"UTC",27),"26/07/19/27");
});

test("computes the business date at timezone boundaries",()=>{
  const date=new Date("2026-12-31T16:00:00Z");
  assert.equal(businessDate(date,"UTC"),"2026-12-31");
  assert.equal(businessDate(date,"Asia/Shanghai"),"2027-01-01");
});

test("validates order templates",()=>{
  assert.equal(validateOrderNumberTemplate("{YYYY}{MM}{DD}-{SEQ:3}"),null);
  assert.equal(validateOrderNumberTemplate("SO-{YY}-{MM}-{DD}-{SEQ:9}"),null);
  assert.match(validateOrderNumberTemplate("{YYYY}{MM}-{SEQ:3}")??"",/日期/);
  assert.match(validateOrderNumberTemplate("{YYYY}{MM}{DD}-{SEQ:0}")??"",/位数/);
  assert.match(validateOrderNumberTemplate("{YYYY}{MM}{DD}-{FOO}")??"",/不支持/);
  assert.match(validateOrderNumberTemplate("{YYYY}{YY}{MM}{DD}-{SEQ:3}")??"",/必须且只能/);
});

test("validates IANA timezones",()=>{
  assert.equal(isValidTimeZone("Asia/Shanghai"),true);
  assert.equal(isValidTimeZone("Not/A_Timezone"),false);
});
