import type {PoolClient} from "pg";
import {transaction} from "./db.js";
import {generateStatusSlots,type StatusSchedule} from "./status-schedule.js";

type CampaignRow={
  id:string;timezone:string;start_date:string;end_date:string;active_weekdays:number[];
  daily_start:string;daily_end:string;interval_minutes:number;status:string;
};

function dateOnly(value:unknown):string{
  if(value instanceof Date)return value.toISOString().slice(0,10);
  return String(value).slice(0,10);
}

function timeOnly(value:unknown):string{return String(value).slice(0,5);}

function campaignSchedule(row:CampaignRow):StatusSchedule{
  return{
    timezone:String(row.timezone),
    startDate:dateOnly(row.start_date),
    endDate:dateOnly(row.end_date),
    activeWeekdays:(row.active_weekdays??[]).map(Number),
    dailyStart:timeOnly(row.daily_start),
    dailyEnd:timeOnly(row.daily_end),
    intervalMinutes:Number(row.interval_minutes),
  };
}

async function statusWebhook(client:PoolClient,eventType:string,postId:string,payload:Record<string,unknown>):Promise<void>{
  const event=await client.query("INSERT INTO webhook_events(event_type,aggregate_id,payload) VALUES($1,$2,$3) RETURNING id",[eventType,postId,JSON.stringify(payload)]);
  await client.query("INSERT INTO webhook_deliveries(event_id,endpoint_id) SELECT $1,id FROM webhook_endpoints WHERE enabled AND $2=ANY(event_types) ON CONFLICT DO NOTHING",[event.rows[0].id,eventType]);
}

export async function rescheduleStatusCampaign(client:PoolClient,campaignId:string,notBefore=new Date()):Promise<{scheduled:number;expired:number;capacity:number}>{
  const found=await client.query("SELECT * FROM status_campaigns WHERE id=$1 FOR UPDATE",[campaignId]);
  if(!found.rowCount)throw Object.assign(new Error("status_campaign_not_found"),{statusCode:404});
  const campaign=found.rows[0] as CampaignRow;
  const pending=await client.query("SELECT id FROM status_posts WHERE campaign_id=$1 AND status IN ('queued','scheduled') ORDER BY position,id FOR UPDATE",[campaignId]);
  const slots=generateStatusSlots(campaignSchedule(campaign),notBefore);
  let scheduled=0,expired=0;
  for(const [index,row] of pending.rows.entries()){
    const slot=slots[index];
    if(slot){
      await client.query("UPDATE status_posts SET status='scheduled',scheduled_at=$2,last_error=NULL,updated_at=now() WHERE id=$1",[row.id,slot]);
      scheduled++;
    }else{
      await client.query("UPDATE status_posts SET status='expired',scheduled_at=NULL,last_error='schedule_window_exhausted',updated_at=now() WHERE id=$1",[row.id]);
      await statusWebhook(client,"status.expired",String(row.id),{statusPostId:row.id,campaignId,reason:"schedule_window_exhausted",at:new Date().toISOString()});
      expired++;
    }
  }
  if(campaign.status==="active"&&!scheduled){
    await client.query("UPDATE status_campaigns SET status='completed',completed_at=now(),updated_at=now() WHERE id=$1",[campaignId]);
  }
  return{scheduled,expired,capacity:slots.length};
}

async function completeCampaignIfDone(client:PoolClient,campaignId:string):Promise<void>{
  const active=await client.query("SELECT 1 FROM status_posts WHERE campaign_id=$1 AND status IN ('queued','scheduled','dispatching') LIMIT 1",[campaignId]);
  if(!active.rowCount)await client.query("UPDATE status_campaigns SET status='completed',completed_at=COALESCE(completed_at,now()),updated_at=now() WHERE id=$1 AND status='active'",[campaignId]);
}

export async function processOneStatusCycle():Promise<boolean>{
  return transaction(async client=>{
    const due=await client.query(`SELECT p.id,p.campaign_id,p.account_id,p.content_type,p.text_content,p.media_id,p.background_color,p.font,
      c.status campaign_status,a.status account_status,a.agent_id,g.status agent_status,g.capabilities
      FROM status_posts p JOIN status_campaigns c ON c.id=p.campaign_id JOIN whatsapp_accounts a ON a.id=p.account_id
      LEFT JOIN agents g ON g.id=a.agent_id
      WHERE p.status='scheduled' AND p.scheduled_at<=now() AND c.status='active'
      ORDER BY p.scheduled_at,p.position FOR UPDATE OF p SKIP LOCKED LIMIT 1`);
    if(!due.rowCount)return false;
    const post=due.rows[0],capabilities=Array.isArray(post.capabilities)?post.capabilities.map(String):[];
    if(post.account_status!=="online"||post.agent_status!=="online"||!post.agent_id||!capabilities.includes("publish_status_v1")){
      await rescheduleStatusCampaign(client,String(post.campaign_id),new Date(Date.now()+60_000));
      return true;
    }
    const recipients=await client.query("SELECT jid FROM status_campaign_recipients WHERE campaign_id=$1 ORDER BY jid",[post.campaign_id]);
    const audienceJids=recipients.rows.map(row=>String(row.jid)).filter(jid=>/^\d{7,15}@s\.whatsapp\.net$/.test(jid));
    if(!audienceJids.length){
      await client.query("UPDATE status_posts SET status='failed',last_error='status_audience_empty',updated_at=now() WHERE id=$1",[post.id]);
      await statusWebhook(client,"status.failed",String(post.id),{statusPostId:post.id,campaignId:post.campaign_id,error:"status_audience_empty",at:new Date().toISOString()});
      await completeCampaignIfDone(client,String(post.campaign_id));
      return true;
    }
    const payload={statusPostId:post.id,type:post.content_type,text:post.text_content??undefined,mediaId:post.media_id??undefined,backgroundColor:post.background_color??undefined,font:post.font??undefined,audienceJids};
    await client.query("UPDATE status_posts SET status='dispatching',attempt=attempt+1,updated_at=now() WHERE id=$1",[post.id]);
    await client.query("INSERT INTO outbound_commands(agent_id,account_id,status_post_id,command,payload) VALUES($1,$2,$3,'publish_status',$4)",[post.agent_id,post.account_id,post.id,JSON.stringify(payload)]);
    return true;
  });
}

export async function processStatusCommandResult(agentId:string,frame:Record<string,unknown>,command:{id:string;status_post_id:string;state:string}):Promise<void>{
  if(command.state!=="dispatched")return;
  await transaction(async client=>{
    const post=await client.query("SELECT id,campaign_id,status FROM status_posts WHERE id=$1 FOR UPDATE",[command.status_post_id]);
    if(!post.rowCount)return;
    const outcome=String(frame.outcome),error=String(frame.errorMessage??frame.errorCode??"status_publish_failed").slice(0,1000);
    if(outcome==="deferred"){
      await client.query("UPDATE outbound_commands SET state='failed',completed_at=now(),last_error=$3 WHERE id=$1 AND agent_id=$2",[command.id,agentId,error]);
      await client.query("UPDATE status_posts SET status='scheduled',last_error=$2,updated_at=now() WHERE id=$1",[command.status_post_id,error]);
      await rescheduleStatusCampaign(client,String(post.rows[0].campaign_id),new Date(Date.now()+60_000));
      return;
    }
    const state=outcome==="succeeded"?"completed":outcome==="uncertain"?"uncertain":"failed";
    await client.query("UPDATE outbound_commands SET state=$3,completed_at=now(),last_error=$4 WHERE id=$1 AND agent_id=$2",[command.id,agentId,state,error]);
    if(outcome==="succeeded"){
      const publishedAt=new Date();
      await client.query("UPDATE status_posts SET status='published',published_at=$2,expires_at=$2+interval '24 hours',whatsapp_message_id=$3,last_error=NULL,updated_at=now() WHERE id=$1",[command.status_post_id,publishedAt,frame.whatsappMessageId??null]);
      await statusWebhook(client,"status.published",command.status_post_id,{statusPostId:command.status_post_id,campaignId:post.rows[0].campaign_id,whatsappMessageId:frame.whatsappMessageId??null,publishedAt:publishedAt.toISOString(),expiresAt:new Date(publishedAt.getTime()+86_400_000).toISOString()});
    }else if(outcome==="uncertain"){
      await client.query("UPDATE status_posts SET status='uncertain',last_error=$2,updated_at=now() WHERE id=$1",[command.status_post_id,error]);
      await statusWebhook(client,"status.failed",command.status_post_id,{statusPostId:command.status_post_id,campaignId:post.rows[0].campaign_id,status:"uncertain",error,at:new Date().toISOString()});
    }else{
      await client.query("UPDATE status_posts SET status='failed',last_error=$2,updated_at=now() WHERE id=$1",[command.status_post_id,error]);
      await statusWebhook(client,"status.failed",command.status_post_id,{statusPostId:command.status_post_id,campaignId:post.rows[0].campaign_id,status:"failed",error,at:new Date().toISOString()});
    }
    await completeCampaignIfDone(client,String(post.rows[0].campaign_id));
  });
}

export async function recoverStaleStatusCommands():Promise<void>{
  await transaction(async client=>{
    const stale=await client.query(`UPDATE outbound_commands SET state='uncertain',completed_at=now(),last_error='No execution confirmation; status retry stopped to prevent duplicates'
      WHERE status_post_id IS NOT NULL AND state='dispatched' AND claimed_at<now()-interval '2 minutes' RETURNING status_post_id`);
    for(const row of stale.rows){
      const post=await client.query("UPDATE status_posts SET status='uncertain',last_error='No execution confirmation; automatic retry stopped',updated_at=now() WHERE id=$1 AND status='dispatching' RETURNING id,campaign_id",[row.status_post_id]);
      if(post.rowCount){
        await statusWebhook(client,"status.failed",String(post.rows[0].id),{statusPostId:post.rows[0].id,campaignId:post.rows[0].campaign_id,status:"uncertain",error:"execution_confirmation_timeout",at:new Date().toISOString()});
        await completeCampaignIfDone(client,String(post.rows[0].campaign_id));
      }
    }
  });
}
