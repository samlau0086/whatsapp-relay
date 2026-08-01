import assert from "node:assert/strict";
import test from "node:test";
import {generateStatusSlots,isValidIanaTimeZone,statusDateOnly} from "../src/status-schedule.js";

test("status schedule resets its cadence inside each allowed local-day window",()=>{
  const slots=generateStatusSlots({timezone:"Asia/Shanghai",startDate:"2026-07-27",endDate:"2026-07-28",activeWeekdays:[1,2],dailyStart:"09:00",dailyEnd:"12:00",intervalMinutes:180});
  assert.deepEqual(slots.map(value=>value.toISOString()),["2026-07-27T01:00:00.000Z","2026-07-27T04:00:00.000Z","2026-07-28T01:00:00.000Z","2026-07-28T04:00:00.000Z"]);
});

test("status schedule skips nonexistent DST wall-clock slots without duplicates",()=>{
  const slots=generateStatusSlots({timezone:"America/New_York",startDate:"2026-03-08",endDate:"2026-03-08",activeWeekdays:[0],dailyStart:"01:30",dailyEnd:"03:30",intervalMinutes:60});
  assert.deepEqual(slots.map(value=>value.toISOString()),["2026-03-08T06:30:00.000Z","2026-03-08T07:30:00.000Z"]);
});

test("status schedule honors notBefore and validates IANA zones",()=>{
  const slots=generateStatusSlots({timezone:"UTC",startDate:"2026-07-28",endDate:"2026-07-28",activeWeekdays:[2],dailyStart:"09:00",dailyEnd:"11:00",intervalMinutes:60},new Date("2026-07-28T10:00:00Z"));
  assert.deepEqual(slots.map(value=>value.toISOString()),["2026-07-28T10:00:00.000Z","2026-07-28T11:00:00.000Z"]);
  assert.equal(isValidIanaTimeZone("Asia/Shanghai"),true);
  assert.equal(isValidIanaTimeZone("Not/A_Zone"),false);
});

test("status schedule preserves PostgreSQL date columns as calendar dates",()=>{
  const databaseDate=new Date(2026,7,3);
  assert.equal(statusDateOnly(databaseDate),"2026-08-03");
  assert.equal(statusDateOnly("2026-08-03"),"2026-08-03");
});
