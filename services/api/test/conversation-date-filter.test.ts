import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {CONVERSATION_DATE_FILTERS,conversationCountsPath,conversationDateRange,conversationListPath,conversationSummaryPath} from "../../../app/conversation-date-filter.js";
import {isPostgresUuid} from "../src/conversation-cursor.js";

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

test("cursor IDs accept every PostgreSQL UUID, not only RFC-versioned UUIDs",()=>{
  assert.equal(isPostgresUuid("aaaaaaaa-bbbb-0ccc-7ddd-eeeeeeeeeeee"),true);
  assert.equal(isPostgresUuid("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),true);
  assert.equal(isPostgresUuid("not-a-uuid"),false);
});

test("conversation list and counts paths carry server-side filters without leaking search into counts",()=>{
  const now=new Date(2026,6,26,12),path=conversationListPath("today",now,{filter:"mine",accountId:"account-id",q:" Alice ",tagId:"tag-id",cursor:"cursor",limit:40});
  assert.match(path,/filter=mine/);assert.match(path,/accountId=account-id/);assert.match(path,/q=Alice/);assert.match(path,/tagId=tag-id/);assert.match(path,/cursor=cursor/);
  const counts=conversationCountsPath("today",now,"account-id");
  assert.match(counts,/accountId=account-id/);assert.doesNotMatch(counts,/[?&]q=/);
  const summary=conversationSummaryPath("conversation-id","today",now,{filter:"mine",accountId:"account-id",q:" Alice ",tagId:"tag-id"});
  assert.match(summary,/\/api\/v1\/conversations\/conversation-id\/summary\?/);
  assert.match(summary,/filter=mine/);assert.match(summary,/tagId=tag-id/);assert.doesNotMatch(summary,/[?&]limit=/);
});

test("conversation API applies a closed-open last-message range",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/c\.last_message_at>=\$6/);
  assert.match(server,/c\.last_message_at<\$7/);
  assert.match(server,/invalid_conversation_date_range/);
  assert.match(server,/COALESCE\(c\.last_message_direction,m\.direction\)='in'/);
  assert.match(server,/invalid_unreplied_filter/);
  assert.match(server,/invalid_conversation_filter/);
  assert.match(server,/invalid_cursor/);
  assert.match(server,/invalid_tag_filter/);
  assert.match(server,/selected_tag\.tag_id=\$14/);
  const conversationRoute=server.slice(server.indexOf('app.get("/api/v1/conversations"'),server.indexOf('app.get("/api/v1/conversations/counts"'));
  assert.doesNotMatch(conversationRoute,/COUNT\(\*\) OVER/);
  assert.match(conversationRoute,/total:null/);
  assert.match(conversationRoute,/search_conversations AS MATERIALIZED/);
  assert.match(conversationRoute,/search_conversation\.last_message_text ILIKE/);
  assert.match(conversationRoute,/SELECT search_conversation\.id,search_conversation\.account_id/);
  assert.match(conversationRoute,/SELECT contact_conversation\.id,contact_conversation\.account_id/);
  assert.match(conversationRoute,/const candidateSource=keyword\?"search_conversations c":"conversations c"/);
  assert.doesNotMatch(conversationRoute,/c\.id IN \(SELECT id FROM search_/);
  assert.doesNotMatch(conversationRoute,/legacy_conversation/);
  assert.doesNotMatch(conversationRoute,/m\.text_content ILIKE/);
  assert.match(conversationRoute,/candidates AS MATERIALIZED/);
  assert.match(conversationRoute,/const searchCte=keyword/);
  assert.match(conversationRoute,/const latestSort="COALESCE\(c\.last_message_at,c\.created_at\)"/);
  assert.doesNotMatch(conversationRoute,/const latestSort=.*summary_updated_at/);
  assert.match(conversationRoute,/task\.assigned_user_id=\$9::uuid/);
  assert.match(conversationRoute,/task\.status NOT IN \('completed','cancelled','failed'\)/);
  assert.match(conversationRoute,/task\.due_at<now\(\)\+interval '3 days'/);
  assert.match(conversationRoute,/task\.conversation_id=c\.id OR \(task\.conversation_id IS NULL AND task\.contact_id=c\.contact_id\)/);
  assert.doesNotMatch(conversationRoute,/\$10::text IS NULL OR/);
  assert.match(conversationRoute,/parameter_types AS NOT MATERIALIZED/);
  assert.match(conversationRoute,/\$4::text keyword_value,\$9::uuid principal_user_id,\$10::text filter_value,\$11::timestamptz cursor_at,\$12::uuid cursor_id/);
  assert.doesNotMatch(conversationRoute,/\$10::text filter,/);
  assert.ok(conversationRoute.indexOf("LIMIT $13")<conversationRoute.indexOf("FROM candidates JOIN conversations"),"candidate pagination must happen before detail hydration");
  assert.match(server,/request\.principal\?\.accountIds/);
  const countsRoute=server.slice(server.indexOf('app.get("/api/v1/conversations/counts"'),server.indexOf('app.get("/api/v1/conversations/:id/summary"'));
  assert.match(countsRoute,/const \[result,reminderResult,dueReminderResult\]=await Promise\.all/);
  assert.match(countsRoute,/JOIN conversations c ON c\.id=task\.conversation_id/);
  assert.match(countsRoute,/JOIN conversations c ON c\.contact_id=task\.contact_id/);
  assert.match(countsRoute,/\) reminder_conversations/);
  assert.doesNotMatch(countsRoute,/LEFT JOIN LATERAL \(\s*SELECT task\.due_at/);
  assert.doesNotMatch(countsRoute,/WITH base AS MATERIALIZED/);
});

test("performance reports retain representative HTTP failure details",async()=>{
  const [runner,workflow]=await Promise.all([
    readFile(new URL("../../../performance/conversations/run.mjs",import.meta.url),"utf8"),
    readFile(new URL("../../../.github/workflows/deploy-vps.yml",import.meta.url),"utf8"),
  ]);
  assert.match(runner,/failureSamples/);
  assert.match(runner,/failureSamples\.length<5/);
  assert.match(runner,/\{status:result\.status,body:result\.body\}/);
  assert.match(runner,/const warmup=async\(path,samples=30\)/);
  assert.match(runner,/await warmup\("\/api\/v1\/conversations\?limit=40"\)/);
  assert.match(runner,/await warmup\("\/api\/v1\/conversations\/counts",10\)/);
  assert.ok(runner.indexOf('await warmup("/api/v1/conversations?limit=40")')<runner.indexOf('benchmark("first_page"'),"concurrent warmup must finish before measured first-page samples");
  assert.ok(runner.indexOf('await warmup("/api/v1/conversations/counts",10)')<runner.indexOf('benchmark("counts"'),"concurrent warmup must finish before measured counts samples");
  assert.match(runner,/if\(failure\)throw new Error\(`warmup failed:/);
  assert.match(runner,/Performance gate failed:/);
  assert.match(runner,/counts p95 .* exceeds 800ms/);
  const planStep=workflow.slice(workflow.indexOf("- name: Save database execution plans"),workflow.indexOf("- name: Upload performance artifacts"));
  assert.match(planStep,/continue-on-error: true/);
  assert.match(planStep,/performance\/conversations\/explain\.sql/);
  assert.doesNotMatch(planStep,/grep -[qE]/);
});

test("conversation summaries, events, and startup runner are wired",async()=>{
  const [migration,migrator,events,backfill]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/040_conversation_summaries_events.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/browser-events.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/backfill-conversation-summaries.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/REFERENCING NEW TABLE AS new_messages/);
  assert.match(migration,/relay_conversation_changes/);
  assert.match(migrator,/040_conversation_summaries_events\.sql/);
  assert.match(events,/\/api\/v1\/events\/ticket/);
  assert.match(events,/LISTEN/);
  assert.match(backfill,/conversations_summary_sort_idx ON conversations\(\(COALESCE\(last_message_at,created_at\)\) DESC,id DESC\)/);
  assert.match(backfill,/Number\(indexes\.rows\[0\]\?\.count\)!==3/);
});

test("inbox uses debounced search, cursor loading, realtime reconciliation, and virtualization",async()=>{
  const [ui,panel,feed,pkg]=await Promise.all([
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/conversation-panel.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/use-conversation-feed.ts",import.meta.url),"utf8"),
    readFile(new URL("../../../package.json",import.meta.url),"utf8"),
  ]);
  assert.match(ui,/setDebouncedQuery\(query\.trim\(\)\),300/);
  assert.match(ui,/IntersectionObserver/);
  assert.match(ui,/useVirtualizer/);
  assert.match(ui,/conversationCursorRef/);
  assert.match(ui,/useConversationFeed/);
  assert.match(ui,/tagId:selectedTag/);
  assert.match(panel,/aria-label="按标签筛选会话"/);
  assert.match(feed,/60_000/);
  assert.match(feed,/100/);
  assert.match(pkg,/@tanstack\/react-virtual/);
});

test("inbox bounds media downloads, avoids reconnect reloads, and pages message history",async()=>{
  const [ui,feed,server]=await Promise.all([
    readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),
    readFile(new URL("../../../app/use-conversation-feed.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/server.ts",import.meta.url),"utf8"),
  ]);
  assert.match(ui,/const MEDIA_DOWNLOAD_CONCURRENCY=4/);
  assert.match(ui,/const MEDIA_CACHE_LIMIT=80/);
  assert.match(ui,/rootMargin:"600px 0px"/);
  assert.match(ui,/const MESSAGE_PAGE_SIZE=50/);
  assert.match(ui,/params\.set\("cursor",cursor\)/);
  assert.match(ui,/加载更早消息/);
  assert.doesNotMatch(feed,/onConnected/);
  assert.match(server,/invalid_message_cursor/);
  assert.match(server,/msg\.occurred_at=\$2 AND msg\.id<\$3::uuid/);
  assert.match(server,/Buffer\.from\(JSON\.stringify\(\{occurredAt:/);
});
