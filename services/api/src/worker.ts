import { setTimeout as sleep } from "node:timers/promises";
import { pool, transaction } from "./db.js";
import { decryptAtRest, signWebhook } from "./security.js";
import { config } from "./config.js";
import { processOneAgentJob } from "./agent-engine.js";
import { processOneEmail } from "./email.js";
import { processOneTaskCycle } from "./task-engine.js";
import {processOneCloudOutbound,processOneCloudWebhook,syncDueCloudTemplates} from "./whatsapp-cloud.js";

let stopping=false;
let lastRetention=0;
process.on("SIGTERM",()=>{stopping=true;});
process.on("SIGINT",()=>{stopping=true;});

while(!stopping){
  const agentWork=await processOneAgentJob();
  const emailWork=await processOneEmail();
  const taskWork=await processOneTaskCycle();
  const cloudOutbound=await processOneCloudOutbound();
  const cloudInbound=await processOneCloudWebhook();
  const templateSync=await syncDueCloudTemplates();
  const delivery=await claimWebhook();
  if(delivery)await deliverWebhook(delivery);else if(!agentWork&&!emailWork&&!taskWork&&!cloudOutbound&&!cloudInbound&&!templateSync)await sleep(750);
  await requeueCommands();
  await enforceRetention();
}
await pool.end();

type Delivery={id:number;event_id:string;event_type:string;payload:unknown;occurred_at:string;url:string;secret_encrypted:string;attempt:number};

async function claimWebhook():Promise<Delivery|null>{
  return transaction(async(client)=>{
    const result=await client.query(`SELECT d.id,d.event_id,e.event_type,e.payload,e.occurred_at,w.url,w.secret_encrypted,d.attempt FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN webhook_endpoints w ON w.id=d.endpoint_id WHERE d.state IN ('pending','retry') AND d.available_at<=now() AND w.enabled ORDER BY d.available_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    if(!result.rowCount)return null;
    await client.query("UPDATE webhook_deliveries SET state='delivering',attempt=attempt+1 WHERE id=$1",[result.rows[0].id]);
    return result.rows[0] as Delivery;
  });
}

async function deliverWebhook(item:Delivery):Promise<void>{
  const body=JSON.stringify({id:item.event_id,type:item.event_type,occurredAt:item.occurred_at,data:item.payload});
  const timestamp=Math.floor(Date.now()/1000).toString();
  try{
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),15_000);
    const secret=decryptAtRest(item.secret_encrypted,config.DATA_ENCRYPTION_KEY);
    const response=await fetch(item.url,{method:"POST",headers:{"content-type":"application/json","x-relay-event-id":item.event_id,"x-relay-timestamp":timestamp,"x-relay-signature":signWebhook(secret,timestamp,body)},body,signal:controller.signal});
    clearTimeout(timer);const responseBody=(await response.text()).slice(0,2000);
    if(response.ok)await pool.query("UPDATE webhook_deliveries SET state='completed',response_status=$2,response_body=$3,completed_at=now() WHERE id=$1",[item.id,response.status,responseBody]);
    else await retryWebhook(item,`HTTP ${response.status}`,response.status,responseBody);
  }catch(error){await retryWebhook(item,error instanceof Error?error.message:String(error));}
}

async function retryWebhook(item:Delivery,error:string,status?:number,body?:string):Promise<void>{
  const attempt=item.attempt+1;const expired=new Date(item.occurred_at).getTime()<Date.now()-24*60*60_000;
  if(expired){await pool.query("UPDATE webhook_deliveries SET state='failed',last_error=$2,response_status=$3,response_body=$4,completed_at=now() WHERE id=$1",[item.id,error,status??null,body??null]);return;}
  const delay=Math.min(30*60_000,1000*2**Math.min(attempt,10));
  await pool.query("UPDATE webhook_deliveries SET state='retry',last_error=$2,response_status=$3,response_body=$4,available_at=now()+($5||' milliseconds')::interval WHERE id=$1",[item.id,error,status??null,body??null,String(delay)]);
}

async function requeueCommands():Promise<void>{
  await transaction(async client=>{
    await client.query(`WITH requeued AS (
      UPDATE outbound_commands oc SET state='pending',available_at=now()+interval '5 seconds',claimed_at=NULL,last_error='Agent disconnected before confirmation'
      FROM whatsapp_accounts a WHERE a.id=oc.account_id AND a.transport='web' AND oc.state='dispatched' AND oc.claimed_at<now()-interval '2 minutes' AND oc.attempt<5 RETURNING oc.message_id
    ) UPDATE messages SET status='queued' WHERE id IN (SELECT message_id FROM requeued WHERE message_id IS NOT NULL) AND status='dispatching'`);
    await client.query(`WITH stopped AS (
      UPDATE outbound_commands oc SET state='uncertain',completed_at=now(),last_error='No execution confirmation; automatic retry stopped to prevent duplicates'
      FROM whatsapp_accounts a WHERE a.id=oc.account_id AND a.transport='web' AND oc.state='dispatched' AND oc.claimed_at<now()-interval '2 minutes' AND oc.attempt>=5 RETURNING oc.message_id
    ) UPDATE messages SET status='uncertain' WHERE id IN (SELECT message_id FROM stopped WHERE message_id IS NOT NULL) AND status='dispatching'`);
    await client.query(`WITH stopped AS (
      UPDATE outbound_commands oc SET state='uncertain',completed_at=now(),last_error='Cloud API execution confirmation was interrupted; automatic retry stopped to prevent duplicates'
      FROM whatsapp_accounts a WHERE a.id=oc.account_id AND a.transport='cloud' AND oc.state='dispatched' AND oc.claimed_at<now()-interval '2 minutes' RETURNING oc.message_id
    ) UPDATE messages SET status='uncertain',failure_code='cloud_send_uncertain',failure_message='Cloud API execution confirmation was interrupted' WHERE id IN (SELECT message_id FROM stopped WHERE message_id IS NOT NULL) AND status='dispatching'`);
  });
}

async function enforceRetention():Promise<void>{
  if(Date.now()-lastRetention<60*60_000)return;lastRetention=Date.now();
  await pool.query("UPDATE media m SET delete_after=COALESCE(delete_after,m.created_at+(a.retention_days||' days')::interval) FROM whatsapp_accounts a WHERE m.account_id=a.id AND a.retention_days IS NOT NULL AND m.delete_after IS NULL");
}
