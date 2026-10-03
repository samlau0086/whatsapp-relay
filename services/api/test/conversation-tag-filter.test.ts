import assert from "node:assert/strict";
import test from "node:test";
import {conversationListPath,conversationSummaryPath} from "../../../app/conversation-date-filter.js";
import {matchesConversationTags,parseConversationTagFilter} from "../src/conversation-tag-filter.js";

const first="aaaaaaaa-bbbb-0ccc-7ddd-eeeeeeeeeeee",second="bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";

test("list, pagination and realtime summary preserve multiple tags",()=>{
  const list=new URL(conversationListPath("all",new Date(),{tagIds:[first,second,first],cursor:"next"}),"http://relay.local");
  assert.equal(list.searchParams.get("tagIds"),`${first},${second}`);
  assert.equal(list.searchParams.get("cursor"),"next");
  const summary=new URL(conversationSummaryPath("id","all",new Date(),{tagIds:[first,second]}),"http://relay.local");
  assert.equal(summary.searchParams.get("tagIds"),list.searchParams.get("tagIds"));
  assert.equal(new URL(conversationListPath("all",new Date(),{tagIds:[]}),"http://relay.local").searchParams.has("tagIds"),false);
});

test("tag filters accept legacy single tags and normalize multiple UUIDs",()=>{
  assert.deepEqual(parseConversationTagFilter({}),[]);
  assert.deepEqual(parseConversationTagFilter({tagId:first}),[first]);
  assert.deepEqual(parseConversationTagFilter({tagIds:`${first.toUpperCase()},${second},${first}`}),[first,second]);
  assert.deepEqual(parseConversationTagFilter({tagId:first,tagIds:second}),[first,second]);
  for(const query of [{tagIds:"invalid"},{tagIds:`${first},`},{tagId:"invalid",tagIds:first},{tagIds:[first,second]},{tagId:[first]}])assert.equal(parseConversationTagFilter(query),null);
});

test("multiple tags match any selected tag, including live additions and removals",()=>{
  assert.equal(matchesConversationTags([{id:first}],[first,second]),true);
  assert.equal(matchesConversationTags([{id:second.toUpperCase()}],[first,second]),true);
  assert.equal(matchesConversationTags([{id:first},{id:second}],[first,second]),true);
  assert.equal(matchesConversationTags([],[first,second]),false);
  assert.equal(matchesConversationTags([{id:first}],[second]),false);
  assert.equal(matchesConversationTags(null,[first]),false);
  assert.equal(matchesConversationTags([],[]),true);
});
