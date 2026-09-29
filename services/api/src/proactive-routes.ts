import type {FastifyInstance} from "fastify";
import {pool,transaction} from "./db.js";
import {authenticate,canAccessAccount,type Principal} from "./auth.js";
import {ensureProactiveOutreachTables,normalizeProactiveMessageTemplates,normalizeProactiveEmailTemplates,scanProactiveOutreach,suppressProactiveForContact,isHolidayBlocked} from "./proactive-outreach.js";
import {queueProactiveEmail} from "./proactive-email.js";
const elevated=(role:string|undefined)=>role==="admin"||role==="supervisor";
async function proactiveAccountIds(principal:Principal|undefined):Promise<string[]|null>{
  if(!principal)return[];
  if(principal.kind==="api_key")return principal.accountIds??null;
  if(principal.role==="admin")return null;
  return(await pool.query("SELECT account_id FROM account_permissions WHERE user_id=$1 AND can_read",[principal.id])).rows.map(row=>String(row.account_id));
}
export async function registerProactiveRoutes(app:FastifyInstance){await ensureProactiveOutreachTables();
  app.get("/api/v1/execution-logs",{preHandler:authenticate},async(request,reply)=>{
    const query=request.query as {accountId?:string;q?:string;outcome?:string;limit?:string;offset?:string};
    const accountIds=await proactiveAccountIds(request.principal);
    if(query.accountId&&accountIds!==null&&!accountIds.includes(query.accountId))return reply.code(403).send({error:"account_forbidden"});
    const limit=Math.min(100,Math.max(1,Number(query.limit)||50)),offset=Math.max(0,Number(query.offset)||0);
    const result=await pool.query(`WITH entries AS (
      SELECT e.id::text id,'proactive' category,e.job_id::text subject_id,e.account_id,e.contact_id,e.event_type,
        CASE WHEN e.event_type='sent' THEN 'succeeded' WHEN e.event_type='failed' THEN 'failed' WHEN e.event_type='skipped' THEN 'skipped' WHEN e.event_type='cancelled' THEN 'cancelled' ELSE 'started' END outcome,
        e.reason detail,e.planned_at,e.created_at,j.message_id,e.metadata,
        COALESCE(NULLIF(c.alias,''),c.display_name,c.phone_e164) contact_name,a.display_name account_name,COALESCE(agent.timezone,task_settings.timezone,'Asia/Shanghai') system_timezone
      FROM proactive_outreach_events e JOIN channel_accounts a ON a.id=e.account_id JOIN contacts c ON c.id=e.contact_id
      LEFT JOIN account_agent_settings agent ON agent.account_id=e.account_id LEFT JOIN account_task_settings task_settings ON task_settings.account_id=e.account_id
      LEFT JOIN proactive_outreach_jobs j ON j.id=e.job_id
      UNION ALL
      SELECT l.id::text,'task',l.task_id::text,t.account_id,t.contact_id,l.event_type,l.outcome,l.message,l.planned_at,l.created_at,
        NULL::uuid,'{}'::jsonb,COALESCE(NULLIF(c.alias,''),c.display_name,c.phone_e164),a.display_name,COALESCE(agent.timezone,task_settings.timezone,'Asia/Shanghai')
      FROM task_execution_logs l JOIN tasks t ON t.id=l.task_id JOIN channel_accounts a ON a.id=t.account_id LEFT JOIN contacts c ON c.id=t.contact_id
      LEFT JOIN account_agent_settings agent ON agent.account_id=t.account_id LEFT JOIN account_task_settings task_settings ON task_settings.account_id=t.account_id
    ) SELECT *,COUNT(*) OVER()::int total_count FROM entries
      WHERE ($1::uuid IS NULL OR account_id=$1) AND ($2::uuid[] IS NULL OR account_id=ANY($2))
        AND ($3::text IS NULL OR contact_name ILIKE '%'||$3||'%' OR account_name ILIKE '%'||$3||'%' OR event_type ILIKE '%'||$3||'%')
        AND ($4::text IS NULL OR outcome=$4)
      ORDER BY created_at DESC,id DESC LIMIT $5 OFFSET $6`,[query.accountId??null,accountIds,query.q?.trim()||null,query.outcome||null,limit,offset]);
    return{items:result.rows,total:Number(result.rows[0]?.total_count??0)};
  });
  app.delete("/api/v1/execution-logs/:category/:id",{preHandler:authenticate},async(request,reply)=>{
    if(!elevated(request.principal?.role))return reply.code(403).send({error:"supervisor_required"});
    const {category,id}=request.params as {category:string;id:string};
    if(category!=="task"&&category!=="proactive")return reply.code(400).send({error:"invalid_category"});
    const accountIds=await proactiveAccountIds(request.principal);
    const result=category==="task"
      ? await pool.query("DELETE FROM task_execution_logs l USING tasks t WHERE l.id=$1::uuid AND t.id=l.task_id AND ($2::uuid[] IS NULL OR t.account_id=ANY($2))",[id,accountIds])
      : await pool.query("DELETE FROM proactive_outreach_events e WHERE e.id=$1::uuid AND ($2::uuid[] IS NULL OR e.account_id=ANY($2))",[id,accountIds]);
    if(!result.rowCount)return reply.code(404).send({error:"not_found"});
    return reply.code(204).send();
  });
  app.post("/api/v1/execution-logs/delete",{preHandler:authenticate},async(request,reply)=>{
    if(!elevated(request.principal?.role))return reply.code(403).send({error:"supervisor_required"});
    const body=(request.body??{}) as {items?:Array<{category?:string;id?:string}>};
    const items=(body.items??[]).filter(item=>(item.category==="task"||item.category==="proactive")&&typeof item.id==="string");
    if(!items.length||items.length>200)return reply.code(400).send({error:"invalid_items"});
    const accountIds=await proactiveAccountIds(request.principal);
    const taskIds=items.filter(item=>item.category==="task").map(item=>item.id as string);
    const proactiveIds=items.filter(item=>item.category==="proactive").map(item=>item.id as string);
    const deleted=await transaction(async client=>{
      let count=0;
      if(taskIds.length){const result=await client.query("DELETE FROM task_execution_logs l USING tasks t WHERE l.id=ANY($1::uuid[]) AND t.id=l.task_id AND ($2::uuid[] IS NULL OR t.account_id=ANY($2))",[taskIds,accountIds]);count+=result.rowCount??0;}
      if(proactiveIds.length){const result=await client.query("DELETE FROM proactive_outreach_events e WHERE e.id=ANY($1::uuid[]) AND ($2::uuid[] IS NULL OR e.account_id=ANY($2))",[proactiveIds,accountIds]);count+=result.rowCount??0;}
      return count;
    });
    return{deleted};
  });
  app.delete("/api/v1/execution-logs",{preHandler:authenticate},async(request,reply)=>{
    if(!elevated(request.principal?.role))return reply.code(403).send({error:"supervisor_required"});
    const query=request.query as {accountId?:string;q?:string;outcome?:string};
    const accountIds=await proactiveAccountIds(request.principal);
    if(query.accountId&&accountIds!==null&&!accountIds.includes(query.accountId))return reply.code(403).send({error:"account_forbidden"});
    const deleted=await transaction(async client=>{
      const targets=await client.query(`WITH entries AS (
        SELECT e.id::text id,'proactive' category,e.account_id,e.event_type,
          CASE WHEN e.event_type='sent' THEN 'succeeded' WHEN e.event_type='failed' THEN 'failed' WHEN e.event_type='skipped' THEN 'skipped' WHEN e.event_type='cancelled' THEN 'cancelled' ELSE 'started' END outcome,
          e.reason detail,COALESCE(NULLIF(c.alias,''),c.display_name,c.phone_e164) contact_name,a.display_name account_name
        FROM proactive_outreach_events e JOIN channel_accounts a ON a.id=e.account_id JOIN contacts c ON c.id=e.contact_id
        UNION ALL
        SELECT l.id::text,'task',t.account_id,l.event_type,l.outcome,l.message,COALESCE(NULLIF(c.alias,''),c.display_name,c.phone_e164),a.display_name
        FROM task_execution_logs l JOIN tasks t ON t.id=l.task_id JOIN channel_accounts a ON a.id=t.account_id LEFT JOIN contacts c ON c.id=t.contact_id
      ) SELECT category,id FROM entries WHERE ($1::uuid IS NULL OR account_id=$1) AND ($2::uuid[] IS NULL OR account_id=ANY($2))
        AND ($3::text IS NULL OR contact_name ILIKE '%'||$3||'%' OR account_name ILIKE '%'||$3||'%' OR event_type ILIKE '%'||$3||'%')
        AND ($4::text IS NULL OR outcome=$4)`,[query.accountId??null,accountIds,query.q?.trim()||null,query.outcome||null]);
      const taskIds=targets.rows.filter(row=>row.category==="task").map(row=>row.id);
      const proactiveIds=targets.rows.filter(row=>row.category==="proactive").map(row=>row.id);
      let count=0;
      if(taskIds.length){const result=await client.query("DELETE FROM task_execution_logs WHERE id=ANY($1::uuid[])",[taskIds]);count+=result.rowCount??0;}
      if(proactiveIds.length){const result=await client.query("DELETE FROM proactive_outreach_events WHERE id=ANY($1::uuid[])",[proactiveIds]);count+=result.rowCount??0;}
      return count;
    });
    return{deleted};
  });
  app.get("/api/v1/proactive-outreach/jobs",{preHandler:authenticate},async(request,reply)=>{const query=request.query as {accountId?:string;q?:string;limit?:string;offset?:string};const accountIds=await proactiveAccountIds(request.principal);if(query.accountId&&accountIds!==null&&!accountIds.includes(query.accountId))return reply.code(403).send({error:"account_forbidden"});const limit=Math.min(200,Math.max(1,Number(query.limit)||100)),offset=Math.max(0,Number(query.offset)||0),result=await pool.query(`SELECT j.id,j.account_id,j.contact_id,j.conversation_id,j.trigger_kind,j.planned_at,j.state,j.created_at,j.payload->>'channel' channel,a.display_name account_name,COALESCE(NULLIF(c.alias,''),c.display_name,c.phone_e164) contact_name,COUNT(*) OVER()::int total_count FROM proactive_outreach_jobs j JOIN channel_accounts a ON a.id=j.account_id JOIN contacts c ON c.id=j.contact_id WHERE ($1::uuid IS NULL OR j.account_id=$1) AND ($2::uuid[] IS NULL OR j.account_id=ANY($2)) AND j.state IN ('pending','processing') AND ($3::text IS NULL OR c.alias ILIKE '%'||$3||'%' OR c.display_name ILIKE '%'||$3||'%' OR c.phone_e164 ILIKE '%'||$3||'%' OR a.display_name ILIKE '%'||$3||'%' OR j.trigger_kind ILIKE '%'||$3||'%') ORDER BY j.planned_at,j.id LIMIT $4 OFFSET $5`,[query.accountId??null,accountIds,query.q?.trim()||null,limit,offset]);return{items:result.rows.map(row=>({id:String(row.id),accountId:String(row.account_id),contactId:String(row.contact_id),conversationId:row.conversation_id?String(row.conversation_id):null,triggerKind:String(row.trigger_kind),plannedAt:new Date(String(row.planned_at)).toISOString(),state:String(row.state),createdAt:new Date(String(row.created_at)).toISOString(),accountName:String(row.account_name),contactName:String(row.contact_name??""),channel:row.channel==="email"?"email":"channel"})),total:Number(result.rows[0]?.total_count??0),hasMore:offset+Number(result.rowCount??0)<Number(result.rows[0]?.total_count??0)};});
  app.get("/api/v1/proactive-outreach/events",{preHandler:authenticate},async(request,reply)=>{const query=request.query as {accountId?:string;limit?:string;offset?:string};const accountIds=await proactiveAccountIds(request.principal);if(query.accountId&&accountIds!==null&&!accountIds.includes(query.accountId))return reply.code(403).send({error:"account_forbidden"});const limit=Math.min(200,Math.max(1,Number(query.limit)||100)),offset=Math.max(0,Number(query.offset)||0),result=await pool.query(`SELECT e.id,e.account_id,e.contact_id,e.job_id,e.event_type,e.reason,e.created_at,COALESCE(NULLIF(c.alias,''),c.display_name,c.phone_e164) contact_name,a.display_name account_name,j.planned_at FROM proactive_outreach_events e JOIN channel_accounts a ON a.id=e.account_id JOIN contacts c ON c.id=e.contact_id LEFT JOIN proactive_outreach_jobs j ON j.id=e.job_id WHERE ($1::uuid IS NULL OR e.account_id=$1) AND ($2::uuid[] IS NULL OR e.account_id=ANY($2)) ORDER BY e.created_at DESC LIMIT $3 OFFSET $4`,[query.accountId??null,accountIds,limit,offset]);return{items:result.rows,total:result.rowCount??0};});
  app.get("/api/v1/accounts/:id/proactive-outreach",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(404).send({error:"not_found"});const settings=await pool.query("SELECT * FROM proactive_outreach_settings WHERE account_id=$1",[id]);const stats=await pool.query("SELECT event_type,count(*)::int count FROM proactive_outreach_events WHERE account_id=$1 AND created_at>now()-interval '365 days' GROUP BY event_type",[id]);const upcoming=await pool.query("SELECT j.id,j.contact_id,j.trigger_kind,j.planned_at,j.state,j.payload->>'channel' channel,COALESCE(NULLIF(c.alias,''),c.display_name,c.phone_e164) contact_name FROM proactive_outreach_jobs j JOIN contacts c ON c.id=j.contact_id WHERE j.account_id=$1 AND j.state IN ('pending','processing','awaiting_approval','queued') ORDER BY j.planned_at LIMIT 50",[id]);return{...(settings.rows[0]??{account_id:id,enabled:false,email_enabled:false,email_templates:[],max_touches_per_year:5,max_touches_per_day:20,local_send_start:"10:00",local_send_end:"17:00",country_holidays:{},message_templates:{}}),stats:stats.rows,upcoming:upcoming.rows};});
  app.put("/api/v1/accounts/:id/proactive-outreach",{preHandler:authenticate},async(request,reply)=>{if(!elevated(request.principal?.role))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(404).send({error:"not_found"});const body=(request.body??{}) as Record<string,unknown>,max=Number(body.maxTouchesPerYear??5),dailyMax=Number(body.maxTouchesPerDay??20),start=String(body.localSendStart??"10:00"),end=String(body.localSendEnd??"17:00"),templates=body.messageTemplates??{};const emailTemplates=normalizeProactiveEmailTemplates(body.emailTemplates);if(!Number.isInteger(max)||max<1||max>12||!Number.isInteger(dailyMax)||dailyMax<1||dailyMax>500||!/^\d\d:\d\d$/.test(start)||!/^\d\d:\d\d$/.test(end)||(body.messageTemplates!==undefined&&!normalizeProactiveMessageTemplates(templates).length)||(body.emailEnabled&&!emailTemplates.length)||(Array.isArray(body.emailTemplates)&&emailTemplates.length!==body.emailTemplates.length))return reply.code(400).send({error:"invalid_request"});await pool.query("INSERT INTO proactive_outreach_settings(account_id,enabled,email_enabled,email_templates,max_touches_per_year,max_touches_per_day,local_send_start,local_send_end,country_holidays,message_templates) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(account_id) DO UPDATE SET enabled=EXCLUDED.enabled,email_enabled=EXCLUDED.email_enabled,email_templates=EXCLUDED.email_templates,max_touches_per_year=EXCLUDED.max_touches_per_year,max_touches_per_day=EXCLUDED.max_touches_per_day,local_send_start=EXCLUDED.local_send_start,local_send_end=EXCLUDED.local_send_end,country_holidays=EXCLUDED.country_holidays,message_templates=EXCLUDED.message_templates,updated_at=now()",[id,Boolean(body.enabled),Boolean(body.emailEnabled),JSON.stringify(emailTemplates),max,dailyMax,start,end,JSON.stringify(body.countryHolidays??{}),JSON.stringify(templates)]);return reply.code(204).send();});
  app.get("/api/v1/contacts/:id/proactive-outreach",{preHandler:authenticate},async(request,reply)=>{const {id}=request.params as {id:string};const contact=await pool.query("SELECT account_id,proactive_suppressed_at,proactive_suppression_reason,proactive_email_allowed,country_code FROM contacts WHERE id=$1",[id]);if(!contact.rowCount||!canAccessAccount(request.principal,contact.rows[0].account_id))return reply.code(404).send({error:"not_found"});const events=await pool.query("SELECT * FROM proactive_outreach_events WHERE contact_id=$1 ORDER BY created_at DESC LIMIT 100",[id]);return{...contact.rows[0],events:events.rows};});
  app.put("/api/v1/contacts/:id/proactive-outreach",{preHandler:authenticate},async(request,reply)=>{if(!elevated(request.principal?.role))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};const contact=await pool.query("SELECT account_id FROM contacts WHERE id=$1",[id]);if(!contact.rowCount||!canAccessAccount(request.principal,contact.rows[0].account_id))return reply.code(404).send({error:"not_found"});const body=(request.body??{}) as {suppressed?:boolean;reason?:string;emailAllowed?:boolean};if(body.emailAllowed!==undefined&&typeof body.emailAllowed!=="boolean"||body.suppressed!==undefined&&typeof body.suppressed!=="boolean")return reply.code(400).send({error:"invalid_request"});await transaction(async client=>{if(body.emailAllowed!==undefined){await client.query("UPDATE contacts SET proactive_email_allowed=$2,updated_at=now() WHERE id=$1",[id,body.emailAllowed]);if(!body.emailAllowed){const pending=await client.query("UPDATE proactive_outreach_jobs SET state='cancelled',completed_at=now(),last_error='email_consent_revoked' WHERE contact_id=$1 AND payload->>'channel'='email' AND state IN ('pending','processing','awaiting_approval','queued') RETURNING payload,message_id",[id]);for(const row of pending.rows){if(row.payload?.draftId)await client.query("UPDATE ai_drafts SET status='dismissed',resolved_at=now() WHERE id=$1 AND status='pending'",[row.payload.draftId]);if(row.message_id){const stopped=await client.query("UPDATE email_messages SET status='failed',last_error='email_consent_revoked',completed_at=now() WHERE id=(SELECT email_job_id FROM message_email_details WHERE message_id=$1) AND status IN ('queued','retrying')",[row.message_id]);if(stopped.rowCount)await client.query("UPDATE messages SET status='failed',failure_message='email_consent_revoked' WHERE id=$1 AND status='queued'",[row.message_id]);}}}}if(body.suppressed===true)await suppressProactiveForContact(client,id,String(body.reason??"manual_pause").slice(0,200));else if(body.suppressed===false){await client.query("UPDATE contacts SET proactive_suppressed_at=NULL,proactive_suppression_reason=NULL,updated_at=now() WHERE id=$1",[id]);await client.query("INSERT INTO proactive_outreach_events(account_id,contact_id,event_type,reason) VALUES($1,$2,'restored','manual_restore')",[contact.rows[0].account_id,id]);}});return reply.code(204).send();});
  app.post("/api/v1/ai-drafts/:id/send-email",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const {id}=request.params as {id:string},body=(request.body??{}) as {subject?:unknown;text?:unknown};
    if(body.subject!==undefined&&(typeof body.subject!=="string"||!body.subject.trim()||body.subject.length>200)||body.text!==undefined&&(typeof body.text!=="string"||!body.text.trim()||body.text.length>4500))return reply.code(400).send({error:"invalid_request"});
    const result=await transaction(async client=>{
      const draft=await client.query(`SELECT j.*,d.text_content,d.created_at draft_created_at,c.account_id,co.timezone,co.country,COALESCE(NULLIF(agent.timezone,''),co.timezone,'UTC') account_timezone,s.local_send_start,s.local_send_end,s.country_holidays,s.max_touches_per_day,s.max_touches_per_year FROM proactive_outreach_jobs j JOIN ai_drafts d ON d.id=(j.payload->>'draftId')::uuid JOIN conversations c ON c.id=j.conversation_id JOIN contacts co ON co.id=j.contact_id JOIN proactive_outreach_settings s ON s.account_id=j.account_id LEFT JOIN account_agent_settings agent ON agent.account_id=j.account_id WHERE d.id=$1 AND d.status='pending' AND j.state='awaiting_approval' AND j.payload->>'channel'='email' FOR UPDATE OF j,d,co`,[id]);
      if(!draft.rowCount||!canAccessAccount(request.principal,draft.rows[0].account_id))return null;
      const row=draft.rows[0],subject=String(body.subject??row.payload.subject??"").trim(),text=String(body.text??row.text_content).trim();
      const duplicate=await client.query("SELECT 1 FROM messages WHERE conversation_id=$1 AND direction='in' AND occurred_at>=$2 LIMIT 1",[row.conversation_id,row.draft_created_at]);
      if(duplicate.rowCount)throw Object.assign(new Error("customer_replied"),{statusCode:409});
      const timezone=String(row.timezone||"UTC"),now=new Date(),local=new Intl.DateTimeFormat("en-GB",{timeZone:timezone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now).reduce<Record<string,string>>((parts,part)=>({...parts,[part.type]:part.value}),{}),time=`${local.hour}:${local.minute}`;
      if(isHolidayBlocked(now,timezone,row.country_holidays,row.country).blocked||time<String(row.local_send_start).slice(0,5)||time>String(row.local_send_end).slice(0,5))throw Object.assign(new Error("outside_send_window"),{statusCode:409});
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[row.account_id]);
      const limits=await client.query(`SELECT
        (SELECT count(*)::int FROM proactive_outreach_jobs j JOIN messages m ON m.id=j.message_id WHERE j.account_id=$1 AND j.state IN ('queued','sent') AND m.status IN ('queued','dispatching','sent','delivered','read') AND m.occurred_at>=date_trunc('day',now() AT TIME ZONE $3) AT TIME ZONE $3) daily,
        (SELECT count(*)::int FROM proactive_outreach_jobs j JOIN messages m ON m.id=j.message_id WHERE j.contact_id=$2 AND j.state='sent' AND m.status IN ('sent','delivered','read') AND m.occurred_at>now()-interval '365 days') annual`,[row.account_id,row.contact_id,row.account_timezone]);
      if(Number(limits.rows[0].daily)>=Number(row.max_touches_per_day)||Number(limits.rows[0].annual)>=Number(row.max_touches_per_year))throw Object.assign(new Error("outreach_limit_reached"),{statusCode:409});
      const messageId=await queueProactiveEmail(client,{jobId:String(row.id),accountId:String(row.account_id),contactId:String(row.contact_id),conversationId:String(row.conversation_id),subject,body:text,senderUserId:request.principal!.id});
      await client.query("UPDATE ai_drafts SET status='sent',resolved_at=now(),resolved_by=$2 WHERE id=$1",[id,request.principal!.id]);
      await client.query("INSERT INTO proactive_outreach_events(account_id,contact_id,job_id,event_type,reason,planned_at,metadata) VALUES($1,$2,$3,'planned','email_human_approved',$4,$5)",[row.account_id,row.contact_id,row.id,row.planned_at,JSON.stringify({channel:"email"})]);
      return{messageId};
    });return result?reply.code(202).send(result):reply.code(404).send({error:"not_found"});
  });
  app.post("/api/v1/accounts/:id/proactive-outreach/scan",{preHandler:authenticate},async(request,reply)=>{if(!elevated(request.principal?.role))return reply.code(403).send({error:"supervisor_required"});const {id}=request.params as {id:string};if(!canAccessAccount(request.principal,id))return reply.code(404).send({error:"not_found"});await scanProactiveOutreach(true);return reply.code(202).send();});
}
