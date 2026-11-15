import type {PoolClient} from "pg";
import {z} from "zod";

export const timelineMergeSchema=z.object({conversationIds:z.array(z.string().uuid()).min(2).max(50),targetConversationId:z.string().uuid()})
  .refine(value=>new Set(value.conversationIds).size===value.conversationIds.length&&value.conversationIds.includes(value.targetConversationId),"请选择至少两条不同的会话，并从中选择主会话");

export type TimelineIdentity={id:string;account_id:string;entity_type:string};
export function validateTimelineMerge(rows:TimelineIdentity[],ids:string[]):string|null{
  if(rows.length!==ids.length)return "部分会话不存在，请刷新后重试";
  if(rows.some(row=>row.account_id!==rows[0].account_id))return "只能合并同一个 channel（渠道账号）的会话";
  if(rows.some(row=>row.entity_type!=="person"))return "群会话不能与其他会话合并";
  return null;
}

export async function mergeConversationTimelines(client:PoolClient,ids:string[],targetId:string,actorId:string,canAccess:(accountId:string)=>boolean){
  // 串行化合并操作，避免相反方向的合并形成环或发生部分覆盖。
  await client.query("SELECT pg_advisory_xact_lock(774129704)");
  const found=await client.query<TimelineIdentity>(`SELECT c.id,c.account_id,co.entity_type FROM conversations c JOIN contacts co ON co.id=c.contact_id
    WHERE c.id=ANY($1::uuid[]) ORDER BY c.id FOR UPDATE OF c`,[ids]);
  if(found.rows.some(row=>!canAccess(row.account_id))||found.rows.length!==ids.length)throw Object.assign(new Error("部分会话不存在或没有访问权限"),{statusCode:404});
  const invalid=validateTimelineMerge(found.rows,ids);
  if(invalid)throw Object.assign(new Error(invalid),{statusCode:409});
  const nested=await client.query("SELECT 1 FROM conversation_timeline_merges WHERE source_id=ANY($1::uuid[]) LIMIT 1",[ids]);
  if(nested.rowCount)throw Object.assign(new Error("所选会话已被合并，请刷新后选择主会话"),{statusCode:409});
  const legacy=await client.query("SELECT 1 FROM conversation_merge_links WHERE source_conversation_id=ANY($1::uuid[]) OR target_conversation_id=ANY($1::uuid[]) LIMIT 1",[ids]);
  if(legacy.rowCount)throw Object.assign(new Error("所选会话存在跨账号合并关联，不能再次合并"),{statusCode:409});
  const sources=ids.filter(id=>id!==targetId);
  // 已合并的主会话可继续参与合并，将所有成员展开为单层关系。
  await client.query("UPDATE conversation_timeline_merges SET target_id=$2 WHERE target_id=ANY($1::uuid[])",[sources,targetId]);
  await client.query("INSERT INTO conversation_timeline_merges(source_id,target_id,merged_by) SELECT source_id,$2,$3 FROM unnest($1::uuid[]) source_id",[sources,targetId,actorId]);
  await client.query("SELECT relay_refresh_conversation_summary($1)",[targetId]);
  await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.merge_timelines','conversation',$2,$3)",[actorId,targetId,JSON.stringify({sourceConversationIds:sources})]);
  return{targetConversationId:targetId};
}
