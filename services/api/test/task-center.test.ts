import assert from "node:assert/strict";
import test from "node:test";
import {accountTaskSettingsSchema,contactUpdateSchema,taskCreateSchema,taskUpdateSchema} from "../src/schemas.js";
import {effectiveTaskTools,isLeapYear,nextRecurringDate,observedDate} from "../src/task-engine.js";

const accountId="10000000-0000-4000-8000-000000000009";
const contactId="20000000-0000-4000-8000-000000000009";

test("message tasks require contacts, send times, and valid ranges",()=>{
  const base={accountId,contactId,kind:"message",title:"Birthday greeting",description:"Warm and concise",startAt:"2027-02-20T09:00:00+08:00",dueAt:"2027-02-28T09:00:00+08:00",sendAt:"2027-02-28T09:00:00+08:00",sendMode:"approval",dependencyIds:[]};
  assert.equal(taskCreateSchema.safeParse(base).success,true);
  assert.equal(taskCreateSchema.safeParse({...base,contactId:null}).success,false);
  assert.equal(taskCreateSchema.safeParse({...base,sendAt:null}).success,false);
  assert.equal(taskCreateSchema.safeParse({...base,dueAt:"2027-02-19T09:00:00+08:00"}).success,false);
  assert.equal(taskUpdateSchema.safeParse({progress:50}).success,true);
  assert.equal(taskUpdateSchema.safeParse({}).success,false);
});

test("contact profiles validate birthday and reusable special dates",()=>{
  const profile={alias:"Alice",note:"VIP customer",emails:[],methods:[],addresses:[],birthday:{month:2,day:29,year:null},specialDates:[{kind:"anniversary",label:"First order",month:8,day:12,year:2024,leadDays:10}]};
  assert.equal(contactUpdateSchema.safeParse(profile).success,true);
  assert.equal(contactUpdateSchema.safeParse({...profile,birthday:{month:2,day:30,year:null}}).success,false);
  assert.equal(contactUpdateSchema.safeParse({...profile,specialDates:[{kind:"custom",label:"",month:8,day:12}]}).success,false);
});

test("leap-day observation follows account policy",()=>{
  assert.equal(isLeapYear(2028),true);
  assert.deepEqual(observedDate(2027,2,29,"feb28"),{month:2,day:28});
  assert.deepEqual(observedDate(2027,2,29,"mar1"),{month:3,day:1});
  assert.equal(observedDate(2027,2,29,"leap_year_only"),null);
  assert.deepEqual(observedDate(2028,2,29,"feb28"),{month:2,day:29});
});

test("recurrence produces the next occurrence and respects until",()=>{
  const start=new Date("2027-01-01T01:00:00.000Z");
  assert.equal(nextRecurringDate(start,{kind:"daily",interval:2})?.toISOString(),"2027-01-03T01:00:00.000Z");
  assert.equal(nextRecurringDate(start,{kind:"monthly",interval:1})?.toISOString(),"2027-02-01T01:00:00.000Z");
  assert.equal(nextRecurringDate(start,{kind:"yearly",interval:1,until:"2027-06-01T00:00:00.000Z"}),null);
});

test("task tool overrides replace account defaults with a deny-by-default list",()=>{
  assert.deepEqual(effectiveTaskTools(["knowledge_search","generate_draft"],null),["knowledge_search","generate_draft"]);
  assert.deepEqual(effectiveTaskTools(["knowledge_search"],["contact_profile_read","queue_message","unknown"]),["contact_profile_read","queue_message"]);
  const settings={timezone:"Asia/Shanghai",holidayRegions:["global"],holidays:[{id:"christmas",name:"圣诞节",month:12,day:25},{id:"custom_midyear",name:"年中客户日",month:6,day:18}],defaultLeadDays:14,draftLeadHours:72,defaultSendMode:"approval",leapDayPolicy:"feb28",defaultTools:["generate_draft"]};
  assert.equal(accountTaskSettingsSchema.safeParse(settings).success,true);
  assert.equal(accountTaskSettingsSchema.safeParse({...settings,holidays:[{id:"bad",name:"无效日期",month:2,day:30}]}).success,false);
  assert.equal(accountTaskSettingsSchema.safeParse({...settings,holidays:[settings.holidays[0],settings.holidays[0]]}).success,false);
});
