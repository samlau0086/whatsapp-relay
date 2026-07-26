import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {CONVERSATION_DATE_FILTERS,conversationDateRange,conversationListPath} from "../../../app/conversation-date-filter.js";

test("conversation date filters expose the requested tabs and default all range",()=>{
  assert.deepEqual(CONVERSATION_DATE_FILTERS.map(item=>item.label),["全部","今天","昨天","最近7天","最近15天","未回复"]);
  assert.deepEqual(conversationDateRange("all",new Date(2026,6,26,12)),{});
});

test("conversation date ranges use inclusive local calendar-day starts and exclusive ends",()=>{
  const now=new Date(2026,6,26,15,30);
  const today=new Date(2026,6,26).toISOString(),tomorrow=new Date(2026,6,27).toISOString();
  assert.deepEqual(conversationDateRange("today",now),{from:today,before:tomorrow});
  assert.deepEqual(conversationDateRange("yesterday",now),{from:new Date(2026,6,25).toISOString(),before:today});
  assert.deepEqual(conversationDateRange("last7",now),{from:new Date(2026,6,20).toISOString(),before:tomorrow});
  assert.deepEqual(conversationDateRange("last15",now),{from:new Date(2026,6,12).toISOString(),before:tomorrow});
});

test("conversation date ranges cross month and year boundaries using calendar arithmetic",()=>{
  assert.deepEqual(conversationDateRange("last7",new Date(2026,0,3,9)),{from:new Date(2025,11,28).toISOString(),before:new Date(2026,0,4).toISOString()});
  assert.deepEqual(conversationDateRange("yesterday",new Date(2026,2,1,9)),{from:new Date(2026,1,28).toISOString(),before:new Date(2026,2,1).toISOString()});
});

test("conversation list path only adds date parameters for an active date filter",()=>{
  assert.equal(conversationListPath("all"),"/api/v1/conversations?limit=100");
  assert.equal(conversationListPath("unreplied"),"/api/v1/conversations?limit=100&unreplied=true");
  const path=conversationListPath("today",new Date(2026,6,26,12));
  assert.match(path,/limit=100&lastMessageFrom=/);
  assert.match(path,/&lastMessageBefore=/);
});

test("conversation API applies a closed-open last-message range",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/c\.last_message_at>=\$5/);
  assert.match(server,/c\.last_message_at<\$6/);
  assert.match(server,/invalid_conversation_date_range/);
  assert.match(server,/m\.direction='in'/);
  assert.match(server,/invalid_unreplied_filter/);
});
