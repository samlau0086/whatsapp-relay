import type {PoolClient} from "pg";
import {emailShell,escapeHtml} from "./email.js";
import {resolveEmailProvider} from "./email-provider-routing.js";

export async function queueLivechatTranscript(client:PoolClient,row:{conversation_id:string;account_id:string;contact_id:string;recipient_email:string|null},clientSendId:string,senderUserId:string|null=null){
  const recipient=String(row.recipient_email??"").trim();
  if(!recipient)throw Object.assign(new Error("visitor_email_required"),{statusCode:409});
  const provider=await resolveEmailProvider(client,row.account_id);
  if(!provider)throw Object.assign(new Error("email_provider_not_configured"),{statusCode:409});
  // 仅导出原访客已接收、已发布的消息，不包含邮件气泡或合并时间线的其他访客。
  const messages=await client.query(`SELECT m.direction,m.kind,m.text_content,m.occurred_at,media.file_name
    FROM messages m LEFT JOIN media ON media.id=m.media_id WHERE m.conversation_id=$1
    AND NOT EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id)
    AND (m.direction='in' OR m.status IN ('sent','delivered','read')) ORDER BY m.occurred_at,m.id`,[row.conversation_id]);
  const lines=messages.rows.map(item=>`[${new Date(item.occurred_at).toISOString()}] ${item.direction==='in'?'Visitor':'Support'}: ${[item.text_content,item.file_name?`[Attachment: ${item.file_name}]`:null].filter(Boolean).join("\n")||'[Message]'}`).join("\n\n");
  const text=`LiveChat transcript\n\n${lines}`;
  const job=await client.query(`INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type)
    VALUES($1,$2,$3,$11,$4,$5,$6,$7,$8,'',$9,$10,'livechat_transcript') RETURNING id,status`,[clientSendId,row.conversation_id,row.contact_id,provider.provider,JSON.stringify(provider.config),provider.secret_encrypted,JSON.stringify([{email:recipient,label:"LiveChat visitor"}]),"Your LiveChat transcript",text,emailShell("",`<h2>LiveChat transcript</h2><p>${escapeHtml(lines)}</p>`),senderUserId]);
  const bubble=await client.query(`INSERT INTO messages(conversation_id,account_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,'out','text',$4,'queued',now()) RETURNING id`,[row.conversation_id,row.account_id,`email:${job.rows[0].id}`,text]);
  await client.query("INSERT INTO message_email_details(message_id,subject,from_email,to_emails,rfc_message_id,email_job_id) VALUES($1,$2,$3,$4,$5,$6)",[bubble.rows[0].id,"Your LiveChat transcript",provider.config.fromEmail,JSON.stringify([recipient]),`<email-${job.rows[0].id}@relaydesk.local>`,job.rows[0].id]);
  return {emailId:String(job.rows[0].id),status:String(job.rows[0].status),recipient};
}
