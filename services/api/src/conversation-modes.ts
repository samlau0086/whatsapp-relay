import type {FastifyInstance} from "fastify";
import {z} from "zod";
import {authenticate,canAccessAccount} from "./auth.js";
import {pool,transaction} from "./db.js";
import {mergeConversationTimelines} from "./timeline-merge.js";

export const conversationModeSql="c.origin_mode";
const whatsappPhoneSql="COALESCE(co.phone_e164,(SELECT '+'||regexp_replace(value,'[^0-9]','','g') FROM contact_methods WHERE contact_id=co.id AND lower(label)='whatsapp' AND regexp_replace(value,'[^0-9]','','g') ~ '^[1-9][0-9]{6,14}$' ORDER BY position,id LIMIT 1))";

export function registerConversationModeRoutes(app:FastifyInstance){
  app.get("/api/v1/conversations/:id/modes",{preHandler:authenticate},async(request,reply)=>{
    const parsed=z.object({id:z.string().uuid()}).safeParse(request.params);
    if(!parsed.success)return reply.code(400).send({error:"invalid_request"});
    const result=await pool.query(`SELECT c.id,c.account_id,c.contact_id,c.service_window_expires_at,${whatsappPhoneSql} phone_e164,co.provider_user_id,co.whatsapp_username,
      COALESCE(NULLIF(co.alias,''),co.display_name,co.phone_e164,'客户') display_name,a.display_name account_name,a.platform,a.transport,a.status account_status,
      (SELECT email FROM contact_emails WHERE contact_id=co.id ORDER BY is_primary DESC,id LIMIT 1) primary_email,
      ${conversationModeSql} conversation_mode,
      EXISTS(SELECT 1 FROM account_email_mailboxes WHERE account_id=c.account_id AND enabled AND send_enabled) has_mailbox,
      EXISTS(SELECT 1 FROM email_provider_instances p WHERE p.enabled AND p.secret_encrypted IS NOT NULL AND
        (p.id=(SELECT provider_id FROM account_email_providers WHERE account_id=c.account_id) OR
        (p.is_default AND NOT EXISTS(SELECT 1 FROM account_email_providers WHERE account_id=c.account_id)))) has_email_provider
      FROM conversations c JOIN contacts co ON co.id=c.contact_id JOIN channel_accounts a ON a.id=c.account_id
      WHERE c.id IN (SELECT relay_conversation_members($1)) ORDER BY (c.id=$1) DESC,c.id`,[parsed.data.id]);
    if(!result.rowCount||result.rows.some(row=>!canAccessAccount(request.principal,row.account_id)))return reply.code(404).send({error:"not_found"});
    return{data:result.rows};
  });

  app.post("/api/v1/conversations/:id/modes/whatsapp",{preHandler:authenticate},async(request,reply)=>{
    if(request.principal?.kind!=="user")return reply.code(403).send({error:"user_required"});
    const params=z.object({id:z.string().uuid()}).safeParse(request.params),body=z.object({accountId:z.string().uuid()}).safeParse(request.body);
    if(!params.success||!body.success)return reply.code(400).send({error:"invalid_request"});
    const principal=request.principal;
    return transaction(async client=>{
      await client.query("SELECT pg_advisory_xact_lock(774129704)");
      const source=await client.query(`SELECT c.id,c.account_id,${whatsappPhoneSql} phone_e164,co.whatsapp_username,co.display_name,co.entity_type
        FROM conversations c JOIN contacts co ON co.id=c.contact_id WHERE c.id IN (SELECT relay_conversation_members($1))
        ORDER BY (c.id=$1) DESC,c.id FOR UPDATE OF c,co`,[params.data.id]);
      if(source.rows.some(item=>!canAccessAccount(principal,item.account_id)))throw Object.assign(new Error("conversation_not_found"),{statusCode:404});
      const row=source.rows.find(item=>item.phone_e164||item.whatsapp_username)??source.rows[0];
      if(!row||row.entity_type!=="person"||!canAccessAccount(principal,row.account_id))throw Object.assign(new Error("conversation_not_found"),{statusCode:404});
      if(!row.phone_e164&&!row.whatsapp_username)throw Object.assign(new Error("请先在客户资料设置 WhatsApp 号码或用户名"),{statusCode:409});
      const account=await client.query("SELECT id FROM channel_accounts WHERE id=$1 AND platform='whatsapp'",[body.data.accountId]);
      if(!account.rowCount||!canAccessAccount(principal,body.data.accountId))throw Object.assign(new Error("account_not_found"),{statusCode:404});
      if(principal.role!=="admin"){
        const permission=await client.query("SELECT 1 FROM account_permissions WHERE account_id=$1 AND user_id=$2 AND can_read AND can_send",[body.data.accountId,principal.id]);
        if(!permission.rowCount)throw Object.assign(new Error("account_send_forbidden"),{statusCode:403});
      }
      const providerId=row.phone_e164?`${String(row.phone_e164).replace(/\D/g,'')}@s.whatsapp.net`:null;
      const existing=await client.query("SELECT id FROM contacts WHERE account_id=$1 AND NOT EXISTS(SELECT 1 FROM conversations existing WHERE existing.contact_id=contacts.id AND existing.origin_mode='email') AND (($2::text IS NOT NULL AND (provider_user_id=$2 OR phone_e164=$3)) OR ($4::text IS NOT NULL AND whatsapp_username=$4)) ORDER BY id LIMIT 1",[body.data.accountId,providerId,row.phone_e164,row.whatsapp_username]);
      const contact=existing.rowCount?existing:await client.query("INSERT INTO contacts(account_id,provider_user_id,phone_e164,whatsapp_username,display_name) VALUES($1,$2,$3,$4,$5) RETURNING id",[body.data.accountId,providerId,row.phone_e164,row.whatsapp_username,row.display_name]);
      if(existing.rowCount&&providerId)await client.query("UPDATE contacts SET provider_user_id=COALESCE(provider_user_id,$2) WHERE id=$1",[contact.rows[0].id,providerId]);
      const target=await client.query("INSERT INTO conversations(account_id,contact_id,status,origin_mode) VALUES($1,$2,'open','whatsapp') ON CONFLICT(account_id,contact_id) DO UPDATE SET status='open',closed_at=NULL RETURNING id",[body.data.accountId,contact.rows[0].id]);
      const targetId=String(target.rows[0].id);
      if(targetId!==params.data.id&&!source.rows.some(item=>item.id===targetId))await mergeConversationTimelines(client,[params.data.id,targetId],params.data.id,principal.id,id=>canAccessAccount(principal,id));
      return{conversationId:targetId};
    });
  });
}
