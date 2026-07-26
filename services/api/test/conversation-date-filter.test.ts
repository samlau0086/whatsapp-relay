import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {CONVERSATION_DATE_FILTERS,conversationCountsPath,conversationDateRange,conversationListPath} from "../../../app/conversation-date-filter.js";

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
  assert.equal(conversationListPath("all"),"/api/v1/conversations?limit=40");
  assert.equal(conversationListPath("unreplied"),"/api/v1/conversations?limit=40&unreplied=true");
  const path=conversationListPath("today",new Date(2026,6,26,12));
  assert.match(path,/limit=40&lastMessageFrom=/);
  assert.match(path,/&lastMessageBefore=/);
});

test("conversation list and counts paths carry server-side filters without leaking search into counts",()=>{
  const now=new Date(2026,6,26,12),path=conversationListPath("today",now,{filter:"mine",accountId:"account-id",q:" Alice ",cursor:"cursor",limit:40});
  assert.match(path,/filter=mine/);assert.match(path,/accountId=account-id/);assert.match(path,/q=Alice/);assert.match(path,/cursor=cursor/);
  const counts=conversationCountsPath("today",now,"account-id");
  assert.match(counts,/accountId=account-id/);assert.doesNotMatch(counts,/[?&]q=/);
});

test("conversation API applies a closed-open last-message range",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/c\.last_message_at>=\$6/);
  assert.match(server,/c\.last_message_at<\$7/);
  assert.match(server,/invalid_conversation_date_range/);
  assert.match(server,/m\.direction='in'/);
  assert.match(server,/invalid_unreplied_filter/);
  assert.match(server,/invalid_conversation_filter/);
  assert.match(server,/invalid_cursor/);
  assert.match(server,/m\.text_content ILIKE/);
  assert.match(server,/COUNT\(\*\) OVER\(\)::int total_count/);
  assert.match(server,/request\.principal\?\.accountIds/);
});

test("conversation performance migration and startup runner are wired",async()=>{
  const [migration,migrator]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/039_conversation_list_performance.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/CREATE EXTENSION IF NOT EXISTS pg_trgm/);
  assert.match(migration,/contacts_alias_trgm_idx/);
  assert.match(migration,/conversations_account_sort_idx/);
  assert.match(migrator,/039_conversation_list_performance\.sql/);
});

test("inbox uses debounced server search, cursor loading, polling merge, and virtualization",async()=>{
  const [ui,pkg]=await Promise.all([
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../package.json",import.meta.url),"utf8"),
  ]);
  assert.match(ui,/setDebouncedQuery\(query\.trim\(\)\),300/);
  assert.match(ui,/IntersectionObserver/);
  assert.match(ui,/useVirtualizer/);
  assert.match(ui,/conversationCursorRef/);
  assert.match(ui,/quiet:true,notify:true/);
  assert.match(pkg,/@tanstack\/react-virtual/);
});
