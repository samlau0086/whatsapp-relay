import type { PoolClient } from "pg";

export type MergeIdentity={id:string;account_id:string;contact_id:string;provider_user_id:string|null;phone_e164:string|null;whatsapp_username:string|null;entity_type:string;platform:string;transport:string};

export function validateSameAccountMerge(source:MergeIdentity,target:MergeIdentity):string|null{
  if(source.id===target.id)return "请选择另一条会话作为主会话";
  if(source.account_id!==target.account_id)return "只能合并同一账号下的会话";
  if(source.platform!=="whatsapp"||source.transport!=="web"||source.entity_type!=="person"||target.entity_type!=="person")return "仅支持同一 WhatsApp Web 账号下的单人会话";
  if(!/^\d{7,15}@(lid|s\.whatsapp\.net)$/.test(source.provider_user_id??""))return "待合并会话缺少可用的 WhatsApp 身份";
  if(target.provider_user_id&&target.provider_user_id!==source.provider_user_id)return "主会话已有不同的 WhatsApp 身份，无法安全合并";
  if(source.phone_e164&&target.phone_e164&&source.phone_e164!==target.phone_e164)return "两个联系人手机号不同，无法安全合并";
  if(source.whatsapp_username&&target.whatsapp_username&&source.whatsapp_username.toLowerCase()!==target.whatsapp_username.toLowerCase())return "两个联系人用户名不同，无法安全合并";
  return null;
}

// Resolve foreign keys from the live schema so later migrations cannot silently
// cascade-delete records which this merge has not accounted for.
async function references(client:PoolClient,table:"contacts"|"conversations"){
  const result=await client.query(`SELECT child.relname AS table_name,attribute.attname AS column_name
    FROM pg_constraint constraint_row
    JOIN pg_class parent ON parent.oid=constraint_row.confrelid
    JOIN pg_namespace parent_schema ON parent_schema.oid=parent.relnamespace
    JOIN pg_class child ON child.oid=constraint_row.conrelid
    JOIN pg_namespace child_schema ON child_schema.oid=child.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid=child.oid AND attribute.attnum=constraint_row.conkey[1]
    WHERE constraint_row.contype='f' AND parent_schema.nspname=current_schema()
      AND child_schema.nspname=current_schema() AND parent.relname=$1
      AND cardinality(constraint_row.conkey)=1 AND cardinality(constraint_row.confkey)=1`,[table]);
  return result.rows as Array<{table_name:string;column_name:string}>;
}

function identifier(value:string){return `"${value.replaceAll('"','""')}"`;}

async function moveReferences(client:PoolClient,table:"contacts"|"conversations",source:string,target:string,skip:Set<string>){
  for(const ref of await references(client,table)){
    if(skip.has(`${ref.table_name}.${ref.column_name}`))continue;
    const name=identifier(ref.table_name),column=identifier(ref.column_name);
    await client.query(`UPDATE ${name} SET ${column}=$2 WHERE ${column}=$1`,[source,target]);
  }
}

async function assertNoReferences(client:PoolClient,table:"contacts"|"conversations",source:string,skip:Set<string>){
  for(const ref of await references(client,table)){
    if(skip.has(`${ref.table_name}.${ref.column_name}`))continue;
    const result=await client.query(`SELECT 1 FROM ${identifier(ref.table_name)} WHERE ${identifier(ref.column_name)}=$1 LIMIT 1`,[source]);
    if(result.rowCount)throw new Error(`unmoved_merge_reference:${ref.table_name}.${ref.column_name}`);
  }
}

export async function mergeSameAccountConversations(client:PoolClient,source:MergeIdentity,target:MergeIdentity,actorId:string){
  // Active work must finish on its original identity before it can be moved.
  const active=await client.query(`SELECT 1 FROM outbound_commands o JOIN messages m ON m.id=o.message_id WHERE m.conversation_id=ANY($1::uuid[]) AND o.state IN ('pending','dispatched')
    UNION ALL SELECT 1 FROM email_messages WHERE conversation_id=ANY($1::uuid[]) AND status IN ('queued','sending','retrying')
    UNION ALL SELECT 1 FROM agent_runs WHERE conversation_id=ANY($1::uuid[]) AND status='running'
    UNION ALL SELECT 1 FROM agent_jobs WHERE conversation_id=ANY($1::uuid[]) AND state IN ('pending','processing')
    UNION ALL SELECT 1 FROM proactive_outreach_jobs WHERE contact_id=ANY($2::uuid[]) AND state IN ('pending','processing') LIMIT 1`,[[source.id,target.id],[source.contact_id,target.contact_id]]);
  if(active.rowCount)return "请等待待发送消息或正在处理的任务完成后再合并";
  const linked=await client.query("SELECT 1 FROM conversation_merge_links WHERE source_conversation_id=ANY($1::uuid[]) OR target_conversation_id=ANY($1::uuid[]) LIMIT 1",[[source.id,target.id]]);
  if(linked.rowCount)return "会话已参与其他合并，请先核对历史记录";
  const profileFields=["alias","first_name","middle_name","last_name","birthday_month","birthday_day","birthday_year","timezone","preferred_language","company_name","job_title","country","province","city","country_code"];
  const profiles=await client.query("SELECT * FROM contacts WHERE id=ANY($1::uuid[])",[[source.contact_id,target.contact_id]]);
  const sourceProfile=profiles.rows.find(row=>row.id===source.contact_id),targetProfile=profiles.rows.find(row=>row.id===target.contact_id);
  if(!sourceProfile||!targetProfile)return "联系人资料已变更，请刷新后重试";
  if(profileFields.some(field=>sourceProfile[field]!=null&&targetProfile[field]!=null&&String(sourceProfile[field])!==String(targetProfile[field])))return "两个联系人的资料存在冲突，请先核对姓名、生日或地址资料";
  const pendingDrafts=await client.query("SELECT 1 FROM ai_drafts WHERE conversation_id=$1 AND status='pending' AND EXISTS(SELECT 1 FROM ai_drafts WHERE conversation_id=$2 AND status='pending') LIMIT 1",[source.id,target.id]);
  if(pendingDrafts.rowCount)return "两条会话都有待确认的 AI 草稿，请先处理其中一条";
  await client.query(`UPDATE conversation_agent_state t SET followup_count=t.followup_count+s.followup_count,
    last_customer_message_id=COALESCE(s.last_customer_message_id,t.last_customer_message_id),last_agent_message_id=COALESCE(s.last_agent_message_id,t.last_agent_message_id),updated_at=now()
    FROM conversation_agent_state s WHERE s.conversation_id=$1 AND t.conversation_id=$2`,[source.id,target.id]);
  await client.query("DELETE FROM conversation_agent_state s USING conversation_agent_state t WHERE s.conversation_id=$1 AND t.conversation_id=$2",[source.id,target.id]);
  await client.query(`UPDATE conversation_memories t SET summary=concat_ws(E'\\n\\n',NULLIF(t.summary,''),NULLIF(s.summary,'')),updated_at=now()
    FROM conversation_memories s WHERE s.conversation_id=$1 AND t.conversation_id=$2`,[source.id,target.id]);
  await client.query("DELETE FROM conversation_memories s USING conversation_memories t WHERE s.conversation_id=$1 AND t.conversation_id=$2",[source.id,target.id]);
  await client.query(`DELETE FROM conversation_translation_preferences s USING conversation_translation_preferences t WHERE s.conversation_id=$1 AND t.conversation_id=$2 AND s.user_id=t.user_id`,[source.id,target.id]);
  await client.query(`DELETE FROM conversation_tags s USING conversation_tags t WHERE s.conversation_id=$1 AND t.conversation_id=$2 AND s.tag_id=t.tag_id`,[source.id,target.id]);
  const duplicateReminder=await client.query("SELECT 1 FROM reminders s JOIN reminders t ON s.user_id=t.user_id WHERE s.conversation_id=$1 AND t.conversation_id=$2 LIMIT 1",[source.id,target.id]);
  if(duplicateReminder.rowCount)throw new Error("merge_conflict:两条会话存在同一成员的提醒，请先处理重复提醒");
  const duplicateFact=await client.query("SELECT 1 FROM customer_memory_facts s JOIN customer_memory_facts t ON s.fact_key=t.fact_key WHERE s.conversation_id=$1 AND t.conversation_id=$2 LIMIT 1",[source.id,target.id]);
  if(duplicateFact.rowCount)throw new Error("merge_conflict:两条会话存在重复的客户记忆，请先处理冲突");
  await moveReferences(client,"conversations",source.id,target.id,new Set(["conversations.id","conversation_merge_links.source_conversation_id","conversation_merge_links.target_conversation_id"]));
  await assertNoReferences(client,"conversations",source.id,new Set(["conversations.id"]));
  const sourceConversation=await client.query("SELECT favorite,unread_count,assigned_user_id FROM conversations WHERE id=$1",[source.id]);
  await client.query("UPDATE conversations SET favorite=favorite OR $2,unread_count=unread_count+$3,assigned_user_id=COALESCE(assigned_user_id,$4) WHERE id=$1",[target.id,sourceConversation.rows[0].favorite,sourceConversation.rows[0].unread_count,sourceConversation.rows[0].assigned_user_id]);
  await client.query("DELETE FROM conversations WHERE id=$1",[source.id]);
  // Release the unique (account,JID) slot before assigning it to the retained contact.
  await client.query("UPDATE contacts SET provider_user_id=NULL WHERE id=$1",[source.contact_id]);
  const profileMerge=profileFields.map(field=>`${identifier(field)}=COALESCE(t.${identifier(field)},s.${identifier(field)})`).join(",");
  await client.query(`UPDATE contacts t SET provider_user_id=$2,phone_e164=COALESCE(t.phone_e164,s.phone_e164),whatsapp_username=COALESCE(t.whatsapp_username,s.whatsapp_username),display_name=COALESCE(t.display_name,s.display_name),avatar_url=COALESCE(t.avatar_url,s.avatar_url),
    note=CASE WHEN NULLIF(t.note,'') IS NULL THEN s.note WHEN NULLIF(s.note,'') IS NULL OR t.note=s.note THEN t.note ELSE t.note||E'\\n\\n'||s.note END,
    whatsapp_blocked_at=COALESCE(t.whatsapp_blocked_at,s.whatsapp_blocked_at),whatsapp_blocked_by=COALESCE(t.whatsapp_blocked_by,s.whatsapp_blocked_by),
    proactive_suppressed_at=COALESCE(t.proactive_suppressed_at,s.proactive_suppressed_at),proactive_suppression_reason=COALESCE(t.proactive_suppression_reason,s.proactive_suppression_reason),
    last_seen_at=GREATEST(t.last_seen_at,s.last_seen_at),${profileMerge},updated_at=now() FROM contacts s WHERE t.id=$1 AND s.id=$3`,[target.contact_id,source.provider_user_id,source.contact_id]);
  const duplicateEmail=await client.query("SELECT 1 FROM contact_emails s JOIN contact_emails t ON lower(s.email)=lower(t.email) OR (s.is_primary AND t.is_primary) WHERE s.contact_id=$1 AND t.contact_id=$2 LIMIT 1",[source.contact_id,target.contact_id]);
  if(duplicateEmail.rowCount)throw new Error("merge_conflict:两个联系人有重复或多个主邮箱，请先整理联系人邮箱");
  const duplicateRule=await client.query("SELECT 1 FROM task_rules s JOIN task_rules t ON s.source=t.source AND s.source_key=t.source_key WHERE s.contact_id=$1 AND t.contact_id=$2 LIMIT 1",[source.contact_id,target.contact_id]);
  if(duplicateRule.rowCount)throw new Error("merge_conflict:两个联系人有重复任务规则，请先处理规则冲突");
  await moveReferences(client,"contacts",source.contact_id,target.contact_id,new Set(["conversations.contact_id"]));
  await assertNoReferences(client,"contacts",source.contact_id,new Set());
  await client.query("DELETE FROM contacts WHERE id=$1",[source.contact_id]);
  await client.query("INSERT INTO audit_log(actor_type,actor_id,action,target_type,target_id,metadata) VALUES('user',$1,'conversation.merge_same_account','conversation',$2,$3)",[actorId,target.id,JSON.stringify({sourceConversationId:source.id,sourceContactId:source.contact_id,targetContactId:target.contact_id,providerUserId:source.provider_user_id})]);
  return null;
}
