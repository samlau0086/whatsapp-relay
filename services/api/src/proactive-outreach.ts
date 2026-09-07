import {createHash} from "node:crypto";
import type {PoolClient} from "pg";
import {pool,transaction} from "./db.js";
import {dispatchPending} from "./agent-hub.js";
import {queueChannelCommand} from "./whatsapp-outbound.js";
import {resolveContactTimeZone} from "./contact-timezone.js";

const DAY=86_400_000;
let lastScan=0;
let proactiveSchemaReady:Promise<void>|null=null;

export type HolidayDefinition={id:string;name:string;month:number;day:number;regions?:string[]};
export type ProactiveTemplateScenario="first_touch"|"follow_up";
export type ProactiveMessageTemplate={id?:string;language?:string;scenario?:ProactiveTemplateScenario;customerStages?:string[];body:string};
export type ProactiveReplyDraft={reply:string;replyZh:string;citations:string[];reason:string;contextSnapshot:Record<string,unknown>;language:string;generationMode:"ai"|"fallback";fallbackReason:string|null};

export async function ensureProactiveOutreachTables():Promise<void>{
  proactiveSchemaReady??=(async()=>{
    await pool.query(`CREATE TABLE IF NOT EXISTS proactive_outreach_settings(account_id uuid PRIMARY KEY REFERENCES channel_accounts(id) ON DELETE CASCADE,enabled boolean NOT NULL DEFAULT false,max_touches_per_year smallint NOT NULL DEFAULT 5,max_touches_per_day smallint NOT NULL DEFAULT 20,local_send_start text NOT NULL DEFAULT '10:00',local_send_end text NOT NULL DEFAULT '17:00',country_holidays jsonb NOT NULL DEFAULT '{}'::jsonb,message_templates jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query("ALTER TABLE proactive_outreach_settings ADD COLUMN IF NOT EXISTS max_touches_per_day smallint NOT NULL DEFAULT 20");
    await pool.query("ALTER TABLE proactive_outreach_settings ADD COLUMN IF NOT EXISTS message_templates jsonb NOT NULL DEFAULT '{}'::jsonb");
    await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS proactive_suppressed_at timestamptz`);
    await pool.query(`ALTER TABLE contacts ADD COLUMN IF NOT EXISTS proactive_suppression_reason text`);
    await pool.query(`CREATE TABLE IF NOT EXISTS proactive_outreach_jobs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,trigger_kind text NOT NULL,planned_at timestamptz NOT NULL,state text NOT NULL DEFAULT 'pending',payload jsonb NOT NULL DEFAULT '{}'::jsonb,message_id uuid REFERENCES messages(id) ON DELETE SET NULL,last_error text,completed_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS proactive_outreach_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,job_id uuid REFERENCES proactive_outreach_jobs(id) ON DELETE SET NULL,event_type text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())`);
    await pool.query("CREATE INDEX IF NOT EXISTS proactive_outreach_settings_enabled_idx ON proactive_outreach_settings (enabled) WHERE enabled");
    await pool.query("CREATE INDEX IF NOT EXISTS proactive_outreach_jobs_claim_idx ON proactive_outreach_jobs (planned_at,created_at) WHERE state='pending'");
    await pool.query("CREATE INDEX IF NOT EXISTS proactive_outreach_jobs_contact_state_idx ON proactive_outreach_jobs (contact_id,state)");
    await pool.query("CREATE INDEX IF NOT EXISTS proactive_outreach_jobs_account_state_idx ON proactive_outreach_jobs (account_id,state)");
    await pool.query("CREATE INDEX IF NOT EXISTS proactive_outreach_events_account_time_idx ON proactive_outreach_events (account_id,created_at DESC)");
    await pool.query("CREATE INDEX IF NOT EXISTS proactive_outreach_events_contact_time_idx ON proactive_outreach_events (contact_id,created_at DESC)");
  })();
  return proactiveSchemaReady;
}

export const isProactiveOptOut=(value:string)=>/(\b(stop|unsubscribe|do not contact|don't contact)\b|不要再联系|别再联系|退订|拒收)/i.test(value);
export const proactiveCadenceDays=(touches:number)=>[7,21,45,90][touches]??60+(touches*17)%31;

export function isSafeProactiveReply(reply:string):boolean{
  const text=reply.trim();
  return Boolean(text)&&text.length<=280&&!/\b(refund|chargeback|payment|bank|lawsuit|complaint|cancel order|change order|退款|退货|付款|银行卡|投诉|起诉|取消订单|修改订单)\b/i.test(text);
}

export function resolveProactiveLanguage(preferredLanguage:unknown,fallbackLanguage:unknown):string{
  const preferred=String(preferredLanguage??"").trim();
  if(preferred&&preferred!=="auto")return preferred;
  const fallback=String(fallbackLanguage??"").trim();
  return fallback||"auto";
}

function parseTime(value:string){const [hour,minute]=String(value??"").split(":").map(Number);return{hour:Number.isFinite(hour)?hour:0,minute:Number.isFinite(minute)?minute:0};}
function localParts(date:Date,timeZone:string){const parts=new Intl.DateTimeFormat("en-CA",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",weekday:"short",hourCycle:"h23"}).formatToParts(date);const get=(type:string)=>Number(parts.find(part=>part.type===type)?.value);const weekdayLabel=String(parts.find(part=>part.type==="weekday")?.value??"Sun");return{year:get("year"),month:get("month"),day:get("day"),hour:get("hour"),minute:get("minute"),weekday:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(weekdayLabel)};}
function zonedDate(year:number,month:number,day:number,hour:number,minute:number,timeZone:string){let value=Date.UTC(year,month-1,day,hour,minute);for(let index=0;index<3;index+=1){const parts=localParts(new Date(value),timeZone);const target=Date.UTC(year,month-1,day,hour,minute);const actual=Date.UTC(parts.year,parts.month-1,parts.day,parts.hour,parts.minute);value+=target-actual;}return new Date(value);}
function holidayMatchesCountry(regions:string[],contactCountry?:string|null){const candidate=String(contactCountry??"").trim().toLowerCase();if(!candidate)return regions.some(region=>region.toLowerCase()==="global");return regions.some(region=>{const normalized=region.trim().toLowerCase();return normalized==="global"||normalized===candidate||normalized.includes(candidate)||candidate.includes(normalized);});}
function collectHolidayDefinitions(value:unknown,inheritedRegions:string[]=[]):HolidayDefinition[]{if(Array.isArray(value))return value.flatMap(item=>normalizeHolidayDefinition(item,inheritedRegions)).filter((item):item is HolidayDefinition=>Boolean(item));if(!value||typeof value!=="object")return[];const record=value as Record<string,unknown>;if(typeof record.month!=="undefined"||typeof record.day!=="undefined"){const holiday=normalizeHolidayDefinition(record,inheritedRegions);return holiday?[holiday]:[];}if(Array.isArray(record.holidays))return collectHolidayDefinitions(record.holidays,inheritedRegions);if(Array.isArray(record.items))return collectHolidayDefinitions(record.items,inheritedRegions);if(Array.isArray(record.definitions))return collectHolidayDefinitions(record.definitions,inheritedRegions);return Object.entries(record).flatMap(([key,item])=>{if(key==="holidays"||key==="items"||key==="definitions"||key==="default")return[];return collectHolidayDefinitions(item,[...inheritedRegions,key]);});}
function normalizeHolidayDefinition(value:unknown,inheritedRegions:string[]=[]):HolidayDefinition|null{if(!value||typeof value!=="object")return null;const record=value as Record<string,unknown>;const month=Number(record.month);const day=Number(record.day);const name=String(record.name??"").trim();if(!Number.isInteger(month)||!Number.isInteger(day)||!name)return null;const regions=[...(Array.isArray(record.regions)?record.regions:[]),...(Array.isArray(record.countryCodes)?record.countryCodes:[]),...(Array.isArray(record.countries)?record.countries:[]),...inheritedRegions].map(item=>String(item).trim()).filter(Boolean);return{id:String(record.id??`${month}-${day}-${name}`),name,month,day,regions:regions.length?regions:undefined};}
export function isHolidayBlocked(date:Date,timeZone:string,holidays:unknown,contactCountry?:string|null){const local=localParts(date,timeZone);if(local.weekday===0||local.weekday===6)return{blocked:true,reason:"weekend"};for(const holiday of collectHolidayDefinitions(holidays)){if(holiday.month!==local.month||holiday.day!==local.day)continue;if(holiday.regions?.length&&!holidayMatchesCountry(holiday.regions,contactCountry))continue;return{blocked:true,reason:holiday.name};}return{blocked:false,reason:null};}
export function nextEligibleProactiveRunAt(now:Date,timeZone:string,sendStart:string,sendEnd:string,holidays:unknown,contactCountry?:string|null){const start=parseTime(sendStart);const end=parseTime(sendEnd);let cursor=new Date(now);for(let attempt=0;attempt<21;attempt+=1){const local=localParts(cursor,timeZone);const blocked=isHolidayBlocked(cursor,timeZone,holidays,contactCountry);const windowStart=zonedDate(local.year,local.month,local.day,start.hour,start.minute,timeZone);const windowEnd=zonedDate(local.year,local.month,local.day,end.hour,end.minute,timeZone);if(!blocked.blocked){if(cursor<windowStart)return windowStart;if(cursor<=windowEnd)return cursor;}cursor=zonedDate(local.year,local.month,local.day+1,start.hour,start.minute,timeZone);}return cursor;}
export function nextDailyProactiveRunAt(now:Date,timeZone:string,sendStart:string,sendEnd:string,holidays:unknown,contactCountry?:string|null){const local=localParts(now,timeZone),start=parseTime(sendStart),tomorrow=zonedDate(local.year,local.month,local.day+1,start.hour,start.minute,timeZone);return nextEligibleProactiveRunAt(tomorrow,timeZone,sendStart,sendEnd,holidays,contactCountry);}

function languageMatches(candidate:string,desired:string):boolean{const left=candidate.trim().toLowerCase();const right=desired.trim().toLowerCase();if(!left||!right||right==="auto")return true;return left===right||left.startsWith(`${right}_`)||left.startsWith(`${right}-`)||right.startsWith(`${left}_`)||right.startsWith(`${left}-`);}
function normalizeTemplateScenario(value:unknown):ProactiveTemplateScenario|undefined{return value==="first_touch"||value==="follow_up"?value:undefined;}
function normalizeTemplateCustomerStages(value:unknown):string[]{const values=Array.isArray(value)?value:[value];return [...new Set(values.map(item=>String(item??"").trim()).filter(item=>item==="new"||item==="considering"||item==="qualified"))];}
export function proactiveTemplateScenario(touches:number):ProactiveTemplateScenario{return touches>0?"follow_up":"first_touch";}
export function normalizeProactiveMessageTemplates(value:unknown):ProactiveMessageTemplate[]{
  if(typeof value==="string")return value.trim()?[{body:value.trim()}]:[];
  if(Array.isArray(value))return value.flatMap(item=>normalizeProactiveMessageTemplates(item));
  if(!value||typeof value!=="object")return[];
  const record=value as Record<string,unknown>,body=String(record.body??record.text??record.content??"").trim(),scenario=normalizeTemplateScenario(record.scenario),customerStages=normalizeTemplateCustomerStages(record.customerStages??record.customer_stages??record.customerStage??record.customer_stage);
  if(body)return[{id:typeof record.id==="string"?record.id:undefined,language:typeof record.language==="string"?record.language:undefined,scenario,customerStages:customerStages.length?customerStages:undefined,body}];
  if(Array.isArray(record.templates))return normalizeProactiveMessageTemplates(record.templates);
  return Object.entries(record).flatMap(([language,item])=>{
    if(language==="templates")return[];
    if(typeof item==="string")return item.trim()?[{language:language==="default"?undefined:language,body:item.trim()}]:[];
    if(!item||typeof item!=="object")return[];
    return normalizeProactiveMessageTemplates({...item as Record<string,unknown>,language:(item as Record<string,unknown>).language??(language==="default"?undefined:language)});
  });
}
export function selectProactiveMessageTemplate(templates:unknown,desiredLanguage:string,scenario:ProactiveTemplateScenario="first_touch",customerStage:string="new"):ProactiveMessageTemplate|null{const values=normalizeProactiveMessageTemplates(templates),matches=(template:ProactiveMessageTemplate,requiredScenario:boolean,requiredStage:boolean)=>(!requiredScenario||template.scenario===scenario)&&(!requiredStage||Boolean(template.customerStages?.includes(customerStage))),pick=(candidates:ProactiveMessageTemplate[])=>candidates.find(template=>template.language&&languageMatches(template.language,desiredLanguage))??candidates.find(template=>!template.language)??candidates[0]??null;return pick(values.filter(template=>matches(template,true,true)))??pick(values.filter(template=>matches(template,true,false)&&!template.customerStages?.length))??pick(values.filter(template=>matches(template,false,true)&&!template.scenario))??pick(values.filter(template=>!template.scenario&&!template.customerStages?.length));}
export function renderProactiveMessageTemplate(template:ProactiveMessageTemplate,context:{contactName:string;companyName?:string|null;customerStage:string;lastMessage?:string}):string{return template.body.replace(/{{\s*(contactName|companyName|customerStage|lastMessage)\s*}}/g,(_match,key:string)=>({contactName:context.contactName||"there",companyName:context.companyName||"",customerStage:context.customerStage,lastMessage:context.lastMessage||""})[key]??"").replace(/\s+([,.!?])/g,"$1").replace(/ {2,}/g," ").trim();}

export async function buildProactiveReplyDraft(input:{accountId:string;persona:string;replyLanguage:string;contact:Record<string,unknown>;summary:string;facts:unknown[];orders:unknown[];messages:unknown[];customerStage:string;knowledgeQuery:string;}):Promise<ProactiveReplyDraft>{
  const language=resolveProactiveLanguage(input.contact.preferredLanguage,input.replyLanguage);
  try{
    const {generatePersonalizedTaskMessage}=await import("./agent-engine.js");    const result=await generatePersonalizedTaskMessage({
      accountId:input.accountId,
      persona:input.persona,
      language,
      occasion:"proactive_follow_up",
      taskDescription:"Write a short, low-pressure proactive follow-up for a cold lead. Mention the existing context naturally and end with one simple question or next step.",
      contact:input.contact,
      notes:[{key:"customer_stage",value:input.customerStage,confidence:1}],
      tags:["proactive",input.customerStage],
      memory:{summary:input.summary},
      facts:input.facts,
      messages:input.messages,
      orders:input.orders,
      knowledgeQuery:input.knowledgeQuery,
       allowKnowledge:false,
    });
    if(!isSafeProactiveReply(result.reply))throw new Error("unsafe_reply");
    return{...result,language,generationMode:"ai",fallbackReason:null};
  }catch(error){
    const reason=error instanceof Error?error.message:String(error);
    return{reply:"",replyZh:"",citations:[],reason,contextSnapshot:{contact:input.contact,summary:input.summary,customerStage:input.customerStage,recentMessages:input.messages,orders:input.orders},language,generationMode:"fallback",fallbackReason:reason};
  }
}

export function proactiveScheduleJitter(id:string):number{return createHash("sha256").update(`${id}:${new Date().toISOString().slice(0,10)}`).digest().readUInt32BE(0)%(7*60);}
const audit=async(client:PoolClient,accountId:string,contactId:string,jobId:string|undefined,type:string,reason:string)=>client.query("INSERT INTO proactive_outreach_events(account_id,contact_id,job_id,event_type,reason) VALUES($1,$2,$3,$4,$5)",[accountId,contactId,jobId??null,type,reason]);
export async function cancelProactiveForConversation(client:PoolClient,conversationId:string,reason:string){await ensureProactiveOutreachTables();const rows=await client.query("UPDATE proactive_outreach_jobs SET state='cancelled',completed_at=now(),last_error=$2 WHERE conversation_id=$1 AND state IN ('pending','processing') RETURNING id,account_id,contact_id",[conversationId,reason]);for(const row of rows.rows)await audit(client,row.account_id,row.contact_id,row.id,"cancelled",reason);}
export async function suppressProactiveForContact(client:PoolClient,contactId:string,reason:string){await ensureProactiveOutreachTables();const row=await client.query("UPDATE contacts SET proactive_suppressed_at=now(),proactive_suppression_reason=$2,updated_at=now() WHERE id=$1 RETURNING account_id",[contactId,reason]);if(!row.rowCount)return;await client.query("UPDATE proactive_outreach_jobs SET state='cancelled',completed_at=now(),last_error='suppressed' WHERE contact_id=$1 AND state IN ('pending','processing')",[contactId]);await audit(client,row.rows[0].account_id,contactId,undefined,"suppressed",reason);}

export async function scanProactiveOutreach(){
  await ensureProactiveOutreachTables();
  if(Date.now()-lastScan<60_000)return;
  lastScan=Date.now();
  const rows=await pool.query(`SELECT c.id contact_id,c.account_id,cv.id conversation_id,s.max_touches_per_year,c.country country_code,c.timezone,c.preferred_language,c.company_name,c.alias,c.display_name,c.phone_e164,COALESCE(st.mode,'human_paused') mode,(SELECT max(m.occurred_at) FROM messages m WHERE m.conversation_id=cv.id) last_contact_at,(SELECT count(*)::int FROM proactive_outreach_events e WHERE e.contact_id=c.id AND e.event_type='sent' AND e.created_at>now()-interval '365 days') touches FROM contacts c JOIN conversations cv ON cv.contact_id=c.id JOIN proactive_outreach_settings s ON s.account_id=c.account_id AND s.enabled LEFT JOIN conversation_agent_state st ON st.conversation_id=cv.id WHERE c.entity_type='person' AND c.whatsapp_blocked_at IS NULL AND c.proactive_suppressed_at IS NULL AND cv.status='open' AND cv.customer_stage IN ('new','considering','qualified') AND COALESCE(st.mode,'human_paused')<>'human_paused'`);
  for(const row of rows.rows){
    const touches=Number(row.touches),last=new Date(String(row.last_contact_at??0));
    if(touches>=Number(row.max_touches_per_year)||Date.now()-last.getTime()<proactiveCadenceDays(touches)*DAY)continue;
    await transaction(async client=>{
      const created=await client.query("INSERT INTO proactive_outreach_jobs(account_id,contact_id,conversation_id,trigger_kind,planned_at,payload) SELECT $1,$2,$3,'cold',now()+($4||' minutes')::interval,$5 WHERE NOT EXISTS(SELECT 1 FROM proactive_outreach_jobs WHERE contact_id=$2 AND state IN ('pending','processing')) RETURNING id",[row.account_id,row.contact_id,row.conversation_id,String(proactiveScheduleJitter(String(row.contact_id))),JSON.stringify({touches})]);
      if(created.rowCount)await audit(client,row.account_id,row.contact_id,created.rows[0].id,"planned","cold_cadence");
    });
  }
}

function insideWindow(timeZone:string,start:string,end:string){const p=new Intl.DateTimeFormat("en-GB",{timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date()).reduce<Record<string,string>>((r,x)=>({...r,[x.type]:x.value}),{}),now=`${p.hour}:${p.minute}`;return start<=end?now>=start&&now<=end:now>=start||now<=end;}
async function deferProactiveJob(client:PoolClient,job:Record<string,unknown>,plannedAt:Date,reason:string,metadata:Record<string,unknown>){await client.query("UPDATE proactive_outreach_jobs SET state='pending',planned_at=$2,last_error=$3,payload=payload || $4::jsonb,updated_at=now() WHERE id=$1",[job.id,plannedAt.toISOString(),reason,JSON.stringify(metadata)]);await audit(client,String(job.account_id),String(job.contact_id),String(job.id),"skipped",reason);}

export async function processOneProactiveOutreach():Promise<boolean>{
  await scanProactiveOutreach();
  const job=await transaction(async client=>{const q=await client.query(`SELECT j.*,a.agent_id,a.platform,a.transport,co.provider_user_id,co.timezone,co.preferred_language,co.country country_code,COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164) contact_name,co.company_name,COALESCE(s.local_send_start,'10:00') local_send_start,COALESCE(s.local_send_end,'17:00') local_send_end,COALESCE(s.max_touches_per_year,5) max_touches_per_year,COALESCE(s.max_touches_per_day,20) max_touches_per_day,s.country_holidays,s.message_templates,c.status conversation_status,c.customer_stage,c.service_window_expires_at,COALESCE(st.mode,'human_paused') mode,mem.summary,COALESCE(agent.persona,'You are a helpful, concise relationship assistant.') persona,COALESCE(agent.reply_language,'auto') reply_language,COALESCE(NULLIF(agent.timezone,''),co.timezone,'UTC') account_timezone FROM proactive_outreach_jobs j JOIN channel_accounts a ON a.id=j.account_id JOIN contacts co ON co.id=j.contact_id JOIN conversations c ON c.id=j.conversation_id LEFT JOIN proactive_outreach_settings s ON s.account_id=j.account_id LEFT JOIN account_agent_settings agent ON agent.account_id=j.account_id LEFT JOIN conversation_agent_state st ON st.conversation_id=j.conversation_id LEFT JOIN conversation_memories mem ON mem.conversation_id=j.conversation_id WHERE j.state='pending' AND j.planned_at<=now() ORDER BY j.planned_at FOR UPDATE SKIP LOCKED LIMIT 1`);if(!q.rowCount)return null;await client.query("UPDATE proactive_outreach_jobs SET state='processing' WHERE id=$1",[q.rows[0].id]);return q.rows[0];});
  if(!job)return false;
  try{
    await transaction(async client=>{
      const valid=await client.query("SELECT c.whatsapp_blocked_at,c.proactive_suppressed_at,c.timezone,c.preferred_language,c.country country_code,c.alias,c.display_name,c.phone_e164,c.company_name,cv.status,cv.customer_stage,COALESCE(st.mode,'human_paused') mode,(SELECT count(*)::int FROM proactive_outreach_events e WHERE e.contact_id=c.id AND e.event_type='sent' AND e.created_at>now()-interval '365 days') touches FROM contacts c JOIN conversations cv ON cv.id=$2 LEFT JOIN conversation_agent_state st ON st.conversation_id=cv.id WHERE c.id=$1 FOR UPDATE",[job.contact_id,job.conversation_id]);
      const state=valid.rows[0];
      if(!state||state.whatsapp_blocked_at||state.proactive_suppressed_at||state.status!=="open"||!["new","considering","qualified"].includes(state.customer_stage)||state.mode==="human_paused"||Number(state.touches)>=Number(job.max_touches_per_year)){
        await client.query("UPDATE proactive_outreach_jobs SET state='skipped',completed_at=now(),last_error='eligibility_changed' WHERE id=$1",[job.id]);
        await audit(client,job.account_id,job.contact_id,job.id,"skipped","eligibility_changed");
        return;
      }
      const timezone=String(state.timezone??job.timezone??resolveContactTimeZone(String(state.phone_e164??""),null).timeZone??"UTC"),accountTimezone=String(job.account_timezone??timezone);
      const contactCountry=String(state.country_code??job.country_code??"").trim()||null;
      const windowStart=String(job.local_send_start).slice(0,5),windowEnd=String(job.local_send_end).slice(0,5),now=new Date();
      const blocked=isHolidayBlocked(now,timezone,job.country_holidays,contactCountry),windowOpen=insideWindow(timezone,windowStart,windowEnd);
      if(blocked.blocked||!windowOpen){const reason=blocked.blocked?`holiday_or_weekend:${blocked.reason}`:"outside_local_window",nextRun=nextEligibleProactiveRunAt(now,timezone,windowStart,windowEnd,job.country_holidays,contactCountry);await deferProactiveJob(client,job,nextRun,reason,{generationMode:"deferred",fallbackReason:reason,usedTemplateId:null,holidaySkipped:blocked.blocked});return;}
      const needsOpenServiceWindow=(job.transport==="cloud"&&job.platform==="whatsapp")||job.platform==="messenger",serviceWindowClosed=needsOpenServiceWindow&&(!job.service_window_expires_at||new Date(String(job.service_window_expires_at)).getTime()<=now.getTime());
      if(serviceWindowClosed){const reason="service_window_closed",nextRun=nextEligibleProactiveRunAt(now,timezone,windowStart,windowEnd,job.country_holidays,contactCountry);await deferProactiveJob(client,job,nextRun,reason,{generationMode:"deferred",fallbackReason:reason,usedTemplateId:null,holidaySkipped:false});return;}
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[job.account_id]);
      const dailyCount=await client.query("SELECT count(*)::int count FROM proactive_outreach_events WHERE account_id=$1 AND event_type='sent' AND created_at>=date_trunc('day',now() AT TIME ZONE $2) AT TIME ZONE $2",[job.account_id,accountTimezone]);
      if(Number(dailyCount.rows[0]?.count??0)>=Number(job.max_touches_per_day)){const reason="daily_limit_reached",nextRun=nextDailyProactiveRunAt(now,timezone,windowStart,windowEnd,job.country_holidays,contactCountry);await deferProactiveJob(client,job,nextRun,reason,{generationMode:"deferred",fallbackReason:reason,usedTemplateId:null,holidaySkipped:false});return;}
      const contact={id:String(job.contact_id),name:String(state.alias||state.display_name||state.phone_e164||job.contact_name||""),companyName:String(state.company_name??job.company_name??""),preferredLanguage:state.preferred_language??job.preferred_language??null,timezone,countryCode:contactCountry};
      const facts=await client.query("SELECT fact_key,fact_value,confidence FROM customer_memory_facts WHERE conversation_id=$1 ORDER BY updated_at DESC LIMIT 20",[job.conversation_id]);
      const orders=await client.query("SELECT o.id,o.display_order_number order_number,o.status,o.amount,o.currency,o.description,o.created_at,COALESCE((SELECT json_agg(json_build_object('name',i.product_name,'quantity',i.quantity,'unitAmount',i.unit_amount) ORDER BY i.position) FROM order_items i WHERE i.order_id=o.id),'[]'::json) items FROM orders o WHERE o.conversation_id=$1 AND o.deleted_at IS NULL ORDER BY o.created_at DESC LIMIT 5",[job.conversation_id]);
      const messages=await client.query("SELECT m.id,m.direction,m.kind,COALESCE(m.text_content,t.transcript_text) text_content,m.provider_payload,m.occurred_at FROM messages m LEFT JOIN message_transcriptions t ON t.message_id=m.id WHERE m.conversation_id=$1 ORDER BY m.occurred_at DESC,m.id DESC LIMIT 8",[job.conversation_id]);
      const lastMessage=String(messages.rows[0]?.text_content??""),knowledgeQuery=[String(job.summary??""),contact.name,contact.companyName,String(job.customer_stage??""),lastMessage].join("\n");
      const draft=await buildProactiveReplyDraft({accountId:job.account_id,persona:String(job.persona??"You are a helpful, concise relationship assistant."),replyLanguage:String(job.reply_language??"auto"),contact,summary:String(job.summary??""),facts:facts.rows,orders:orders.rows,messages:messages.rows,customerStage:String(job.customer_stage??"new"),knowledgeQuery});
      const touchCount=Number((job.payload as Record<string,unknown> | null)?.touches??0),templateScenario=proactiveTemplateScenario(touchCount),customerStage=String(job.customer_stage??"new"),selectedTemplate=selectProactiveMessageTemplate(job.message_templates,draft.language,templateScenario,customerStage),templateReply=selectedTemplate?renderProactiveMessageTemplate(selectedTemplate,{contactName:contact.name,companyName:contact.companyName,customerStage,lastMessage}):"",reply=draft.reply.trim()||templateReply,generationMode=draft.reply.trim()?"ai":"system_template",fallbackReason=draft.reply.trim()?null:draft.fallbackReason??"ai_generation_failed";
      if(!isSafeProactiveReply(reply)){const reason=selectedTemplate?"unsafe_system_template":"system_template_unavailable",nextRun=nextEligibleProactiveRunAt(now,timezone,windowStart,windowEnd,job.country_holidays,contactCountry);await deferProactiveJob(client,job,nextRun,reason,{generationMode:"deferred",fallbackReason:reason,usedTemplateId:selectedTemplate?.id??null,holidaySkipped:false});return;}
      const payload:Record<string,unknown>={type:"text",text:reply};
      const message=await client.query("INSERT INTO messages(conversation_id,account_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,'out',$4,$5,'queued',now()) RETURNING id",[job.conversation_id,job.account_id,`proactive-${job.id}`,"text",reply]);
      const queued=await queueChannelCommand(client,{accountId:job.account_id,conversationId:job.conversation_id,messageId:message.rows[0].id,payload:{accountId:job.account_id,conversationId:job.conversation_id,messageId:message.rows[0].id,clientMessageId:`proactive-${job.id}`,toJid:String(job.provider_user_id),...(payload as Record<string,unknown>),type:String(payload.type??"text")}});
      await client.query("UPDATE proactive_outreach_jobs SET state='sent',message_id=$2,completed_at=now(),last_error=NULL,payload=payload || $3::jsonb,updated_at=now() WHERE id=$1",[job.id,message.rows[0].id,JSON.stringify({generationMode,fallbackReason,usedTemplateId:selectedTemplate?.id??null,templateScenario,templateCustomerStage:customerStage,holidaySkipped:false})]);
      await audit(client,job.account_id,job.contact_id,job.id,"sent",generationMode==="ai"?"ai_personalized":"system_template_fallback");
      if(queued.agentId)void dispatchPending(queued.agentId);
    });
  }catch(error){
    const reason=(error instanceof Error?error.message:String(error)).slice(0,500);
    await pool.query("UPDATE proactive_outreach_jobs SET state='failed',completed_at=now(),last_error=$2 WHERE id=$1",[job.id,reason]);
    await pool.query("INSERT INTO proactive_outreach_events(account_id,contact_id,job_id,event_type,reason) VALUES($1,$2,$3,'failed',$4)",[job.account_id,job.contact_id,job.id,reason]);
  }
  return true;
}
