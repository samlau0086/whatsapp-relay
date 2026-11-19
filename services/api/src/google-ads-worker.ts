import {pool,transaction} from "./db.js";
import {config} from "./config.js";
import {decryptAtRest,encryptAtRest} from "./security.js";
import {adsTokenRequest} from "./google-ads-connection.js";

type AdsJob={id:string;order_id?:string;created_at:Date|string;identifiers:Record<string,string>;destination:Record<string,unknown>;consent:string;event_params:Record<string,unknown>};
export function adsConversionBody(job:AdsJob){
  return {destinations:[job.destination],events:[{adIdentifiers:job.identifiers,eventTimestamp:new Date(job.created_at).toISOString(),transactionId:job.order_id??job.id,eventSource:"WEB",
    ...(job.event_params.value!==undefined?{conversionValue:job.event_params.value,currency:job.event_params.currency}:{}),
    ...(job.consent==="granted"?{consent:{adUserData:"CONSENT_GRANTED",adPersonalization:"CONSENT_DENIED"}}:{})}]};
}
export function adsRequestState(body:{requestStatusPerDestination?:Array<{requestStatus?:string;errorInfo?:unknown;warningInfo?:unknown}>}){
  const rows=body.requestStatusPerDestination;
  if(!rows?.length)return {state:"accepted",error:"status_pending"};
  if(rows.some(r=>r.requestStatus==="FAILED"||r.requestStatus==="PARTIAL_SUCCESS"))return {state:"failed",error:"destination_processing_failed"};
  if(rows.every(r=>r.requestStatus==="SUCCESS"))return {state:"sent",error:rows.some(r=>r.warningInfo)?"google_processing_warning":null};
  return {state:"accepted",error:"status_pending"};
}

export async function processOneGoogleAdsConversion():Promise<boolean>{
  await pool.query("UPDATE google_ads_conversion_events SET delivery_state='uncertain',last_error='worker_interrupted',identifiers='{}' WHERE delivery_state='sending' AND available_at<=now()");
  // accepted 任务只重查状态；摄取 POST 一旦结果不明，绝不自动重发。
  const claimed=await pool.query(`WITH next AS (SELECT id FROM google_ads_conversion_events WHERE delivery_state IN ('queued','accepted') AND available_at<=now()
    ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE google_ads_conversion_events e SET delivery_state=CASE WHEN e.delivery_state='queued' THEN 'sending' ELSE e.delivery_state END,
      attempts=e.attempts+1,available_at=now()+interval '2 minutes' FROM next WHERE e.id=next.id RETURNING e.id,e.delivery_state`);
  const claim=claimed.rows[0];if(!claim)return false;
  await transaction(async db=>{
    // 锁顺序固定为归因、渠道、设置、连接、事件，与记录及撤回操作一致。
    const source=(await db.query("SELECT attribution_id FROM google_ads_conversion_events WHERE id=$1",[claim.id])).rows[0];
    const attribution=source?.attribution_id?(await db.query("SELECT * FROM google_ads_attributions WHERE id=$1 FOR UPDATE",[source.attribution_id])).rows[0]:undefined;
    const channel=attribution?(await db.query("SELECT enabled,archived_at FROM livechat_channels WHERE account_id=$1 FOR SHARE",[attribution.account_id])).rows[0]:undefined;
    const settings=attribution?(await db.query("SELECT * FROM google_ads_channel_settings WHERE account_id=$1 FOR SHARE",[attribution.account_id])).rows[0]:undefined;
    const connection=(await db.query("SELECT * FROM google_ads_connection FOR UPDATE")).rows[0];
    const job=(await db.query("SELECT * FROM google_ads_conversion_events WHERE id=$1 FOR UPDATE",[claim.id])).rows[0];
    if(!job||job.delivery_state!==claim.delivery_state)return;
    const finish=async(state:string,error:string|null,requestId?:string)=>db.query(`UPDATE google_ads_conversion_events SET delivery_state=$2,last_error=$3,request_id=COALESCE($4,request_id),
      identifiers=CASE WHEN $2 IN ('queued','sending') THEN identifiers ELSE '{}'::jsonb END,available_at=now()+interval '1 minute' WHERE id=$1`,[job.id,state,error,requestId??null]);
    if(job.delivery_state==="sending"){
      if(attribution?.consent==="denied"){await finish("skipped_consent","consent_withdrawn");return;}
      if(!attribution||!Object.keys(attribution.identifiers).length){await finish("skipped_attribution","attribution_unavailable");return;}
      if(!channel?.enabled||channel.archived_at||!settings?.enabled||!connection?.refresh_token_encrypted||String(settings.revision)!==String(job.config_revision)||String(connection.revision)!==String(job.connection_revision)){
        await finish("skipped_config","ads_config_changed");return;
      }
    }
    if(!connection?.refresh_token_encrypted){await finish(job.delivery_state==="accepted"?"uncertain":"skipped_config","ads_disconnected");return;}
    let token:string;
    try{
      const tokens=await adsTokenRequest({grant_type:"refresh_token",refresh_token:decryptAtRest(connection.refresh_token_encrypted,config.DATA_ENCRYPTION_KEY)});
      token=tokens.access_token;
      if(tokens.refresh_token)await db.query("UPDATE google_ads_connection SET refresh_token_encrypted=$1",[encryptAtRest(tokens.refresh_token,config.DATA_ENCRYPTION_KEY)]);
    }catch{
      const attempts=Number(job.attempts);
      await db.query("UPDATE google_ads_conversion_events SET available_at=now()+interval '5 minutes',last_error='ads_token_unavailable',delivery_state=$2 WHERE id=$1",[job.id,attempts>=5?(job.delivery_state==="accepted"?"uncertain":"failed"):job.delivery_state==="sending"?"queued":"accepted"]);return;
    }
    const headers={authorization:`Bearer ${token}`,"content-type":"application/json"};
    if(job.delivery_state==="accepted"){
      if(Date.now()-new Date(job.created_at).getTime()>7*86400000){await finish("uncertain","status_check_expired");return;}
      try{
        const response=await fetch("https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId="+encodeURIComponent(job.request_id),{headers,redirect:"error",signal:AbortSignal.timeout(10000)});
        if(!response.ok){await finish("accepted",`status_HTTP_${response.status}`);return;}
        const result=adsRequestState(await response.json());await finish(result.state,result.error);
      }catch{await finish("accepted","status_network_unavailable");}
      return;
    }
    try{
      const response=await fetch("https://datamanager.googleapis.com/v1/events:ingest",{method:"POST",headers,redirect:"error",body:JSON.stringify(adsConversionBody(job)),signal:AbortSignal.timeout(10000)});
      if(!response.ok){await finish(response.status>=500?"uncertain":"failed",`ingest_HTTP_${response.status}`);return;}
      const body=await response.json() as {requestId?:string;fieldWarnings?:unknown[]};
      if(!body.requestId){await finish("uncertain","missing_request_id");return;}
      await finish("accepted",body.fieldWarnings?.length?"google_field_warning":null,body.requestId);
    }catch{await finish("uncertain","ingest_network_result_unknown");}
  });
  return true;
}
