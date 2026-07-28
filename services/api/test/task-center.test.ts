import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import {accountTaskSettingsSchema,contactUpdateSchema,taskCreateSchema,taskUpdateSchema} from "../src/schemas.js";
import {effectiveTaskTools,isLeapYear,nextRecurringDate,observedDate} from "../src/task-engine.js";
import {inferContactTimeZone,resolveContactTimeZone} from "../src/contact-timezone.js";

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

test("contact time zones prefer explicit settings and otherwise follow the phone country",()=>{
  assert.deepEqual(inferContactTimeZone("+86 13800138000"),{country:"中国",timeZone:"Asia/Shanghai"});
  assert.deepEqual(inferContactTimeZone("+44 20 7946 0958"),{country:"英国",timeZone:"Europe/London"});
  assert.deepEqual(resolveContactTimeZone("+852 6123 4567",null),{country:"中国香港",timeZone:"Asia/Hong_Kong",source:"country"});
  assert.deepEqual(resolveContactTimeZone("+1 212 555 0100","America/Los_Angeles"),{country:"美国/加拿大",timeZone:"America/Los_Angeles",source:"custom"});
  assert.deepEqual(resolveContactTimeZone("+999123456",null),{country:null,timeZone:"UTC",source:"fallback"});
});

test("contact time zone migration is applied by the API startup migrator",async()=>{
  const [migration,migrator]=await Promise.all([
    readFile(new URL("../../../infra/postgres/migrations/038_contact_timezone.sql",import.meta.url),"utf8"),
    readFile(new URL("../src/migrate-agent.ts",import.meta.url),"utf8"),
  ]);
  assert.match(migration,/ADD COLUMN IF NOT EXISTS timezone text/);
  assert.match(migrator,/038_contact_timezone\.sql/);
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

test("holiday plans can be arranged for every contact from task settings",async()=>{
  const [routes,engine]=await Promise.all([
    readFile(new URL("../src/task-routes.ts",import.meta.url),"utf8"),
    readFile(new URL("../src/task-engine.ts",import.meta.url),"utf8"),
  ]);
  assert.match(routes,/task-settings\/arrange-holidays/);
  assert.match(routes,/create_task_required/);
  assert.match(routes,/task\.holidays\.arrange/);
  assert.match(engine,/export async function arrangeAccountHolidayTasks/);
  assert.match(engine,/contactCount/);
  assert.match(engine,/ruleCount/);
  assert.match(engine,/taskCount/);
});

test("deleted tasks are cancelled and hidden from the default task list",async()=>{
  const routes=await readFile(new URL("../src/task-routes.ts",import.meta.url),"utf8");
  assert.match(routes,/UPDATE tasks SET status='cancelled'/);
  assert.match(routes,/\(\$3::text IS NOT NULL OR t\.status<>'cancelled'\)/);
  assert.match(routes,/app\.delete\("\/api\/v1\/tasks\/:id"/);
});
