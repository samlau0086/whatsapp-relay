import type {PoolClient} from "pg";

// 控制模式跟随主会话，消息、记忆和收件人始终使用原会话。
export const timelineAgentControlJoin=`LEFT JOIN conversation_timeline_merges agent_merge ON agent_merge.source_id=c.id
  LEFT JOIN conversation_agent_state control ON control.conversation_id=COALESCE(agent_merge.target_id,c.id)`;

export async function resolveTimelineAgentControl(client:Pick<PoolClient,"query">,conversationId:string,lock=false):Promise<string|null>{
  const result=await client.query(`SELECT root.id FROM conversations c
    JOIN conversations root ON root.id=COALESCE((SELECT target_id FROM conversation_timeline_merges WHERE source_id=c.id),c.id)
    WHERE c.id=$1${lock?" FOR UPDATE OF root":""}`,[conversationId]);
  return result.rows[0]?.id??null;
}

export async function loadAgentDeliveryContext(client:Pick<PoolClient,"query">,conversationId:string){
  return client.query(`SELECT a.id,a.agent_id,a.transport,co.provider_user_id,s.enabled,COALESCE(control.mode,'human_paused') mode
    FROM conversations c JOIN channel_accounts a ON a.id=c.account_id JOIN contacts co ON co.id=c.contact_id
    LEFT JOIN account_agent_settings s ON s.account_id=c.account_id ${timelineAgentControlJoin} WHERE c.id=$1`,[conversationId]);
}

export async function enqueueTimelineAgentReply(client:Pick<PoolClient,"query">,conversationId:string,messageId:string){
  return client.query(`INSERT INTO agent_jobs(conversation_id,source_message_id,kind,available_at)
    SELECT $1,$2,'reply',now()+interval '3 seconds' WHERE EXISTS(
      SELECT 1 FROM conversations c JOIN account_agent_settings s ON s.account_id=c.account_id
      ${timelineAgentControlJoin} WHERE c.id=$1 AND s.enabled AND control.mode IN ('cautious','full')) ON CONFLICT DO NOTHING`,[conversationId,messageId]);
}

export async function setTimelineAgentMode(client:PoolClient,conversationId:string,body:{mode?:string;proactiveReplyMode?:string},actorId:string){
  const controlId=await resolveTimelineAgentControl(client,conversationId,true);
  if(!controlId)throw Object.assign(new Error("conversation_not_found"),{statusCode:404});
  if(body.mode!==undefined){
    await client.query("INSERT INTO conversation_agent_state(conversation_id,mode,pause_reason) VALUES($1,$2,$3) ON CONFLICT(conversation_id) DO UPDATE SET mode=EXCLUDED.mode,pause_reason=EXCLUDED.pause_reason,updated_at=now()",[controlId,body.mode,body.mode==="human_paused"?"manual_pause":null]);
    if(body.mode==="full")await client.query("UPDATE ai_drafts SET status='dismissed',resolved_at=now(),resolved_by=$2 WHERE conversation_id IN (SELECT relay_conversation_members($1)) AND status='pending'",[controlId,actorId]);
    if(body.mode==="human_paused")await client.query("UPDATE agent_jobs SET state='cancelled',completed_at=now(),last_error='manual_pause' WHERE conversation_id IN (SELECT relay_conversation_members($1)) AND state='pending' AND kind IN ('reply','followup')",[controlId]);
  }
  if(body.proactiveReplyMode!==undefined)await client.query("INSERT INTO conversation_agent_state(conversation_id,proactive_reply_mode) VALUES($1,$2) ON CONFLICT(conversation_id) DO UPDATE SET proactive_reply_mode=EXCLUDED.proactive_reply_mode,updated_at=now()",[controlId,body.proactiveReplyMode]);
}
