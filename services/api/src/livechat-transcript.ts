import type {PoolClient} from "pg";
import {resolveEmailProvider} from "./email-provider-routing.js";
import {defaultTranscriptTemplate,renderTranscript} from "./livechat-transcript-template.js";

export async function queueLivechatTranscript(client:PoolClient,row:{conversation_id:string;account_id:string;contact_id:string;recipient_email:string|null},clientSendId:string,senderUserId:string|null=null,ending=false){
  const recipient=String(row.recipient_email??"").trim();
  if(!recipient)throw Object.assign(new Error("visitor_email_required"),{statusCode:409});
  const provider=await resolveEmailProvider(client,row.account_id);
  if(!provider)throw Object.assign(new Error("email_provider_not_configured"),{statusCode:409});
  const context=await client.query(`SELECT cv.created_at,cv.closed_at,cv.status,co.display_name visitor_name,u.display_name agent_name,
    a.display_name channel_name,c.icon_url,c.transcript_template,now() snapshot_at
    FROM conversations cv JOIN contacts co ON co.id=cv.contact_id
    JOIN livechat_channels c ON c.account_id=cv.account_id JOIN channel_accounts a ON a.id=cv.account_id
    LEFT JOIN users u ON u.id=cv.assigned_user_id WHERE cv.id=$1 AND cv.account_id=$2`,[row.conversation_id,row.account_id]);
  const details=context.rows[0]??{};
  const template={...defaultTranscriptTemplate,...details.transcript_template};
  // 仅导出原访客已接收、已发布的消息，不包含邮件气泡或合并时间线的其他访客。
  const messages=await client.query(`SELECT m.direction,m.kind,m.text_content,m.occurred_at,media.file_name,u.display_name sender_name
    FROM messages m LEFT JOIN media ON media.id=m.media_id LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.conversation_id=$1
    AND NOT EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id)
    AND (m.direction='in' OR m.status IN ('sent','delivered','read')) ORDER BY m.occurred_at,m.id`,[row.conversation_id]);
  const iso=(value:unknown)=>value?(value instanceof Date?value:new Date(String(value))).toISOString():'';
  const started=iso(details.created_at??messages.rows[0]?.occurred_at);
  const end=iso(ending?details.snapshot_at??new Date():details.status==='closed'?details.closed_at:null);
  const until=end||iso(details.snapshot_at??new Date());
  const seconds=started?Math.max(0,Math.floor((Date.parse(until)-Date.parse(started))/1000)):0;
  const {subject,text,html}=renderTranscript(template,{
    visitor:{name:details.visitor_name||'Visitor',email:recipient},
    conversation:{id:row.conversation_id,startedAt:started,endedAt:end,duration:[Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':')},
    agent:{name:details.agent_name||''},department:{name:template.departmentName},
    channel:{name:details.channel_name||'LiveChat',logo:details.icon_url||''},
    messages:messages.rows.map(item=>({body:item.text_content||(!item.file_name?'[Message]':''),time:iso(item.occurred_at),attachments:item.file_name?[String(item.file_name)]:[],direction:item.direction,sender:item.direction==='in'?details.visitor_name||'Visitor':item.sender_name||details.agent_name||details.channel_name||'Support'})),
  });
  const job=await client.query(`INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type)
    VALUES($1,$2,$3,$11,$4,$5,$6,$7,$8,'',$9,$10,'livechat_transcript') RETURNING id,status`,[clientSendId,row.conversation_id,row.contact_id,provider.provider,JSON.stringify(provider.config),provider.secret_encrypted,JSON.stringify([{email:recipient,label:"LiveChat visitor"}]),subject,text,html,senderUserId]);
  const bubble=await client.query("INSERT INTO messages(conversation_id,account_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,'out','text',$4,'queued',now()) RETURNING id",[row.conversation_id,row.account_id,'email:'+job.rows[0].id,text]);
  await client.query("INSERT INTO message_email_details(message_id,subject,from_email,to_emails,rfc_message_id,email_job_id) VALUES($1,$2,$3,$4,$5,$6)",[bubble.rows[0].id,subject,provider.config.fromEmail,JSON.stringify([recipient]),'<email-'+job.rows[0].id+'@relaydesk.local>',job.rows[0].id]);
  return {emailId:String(job.rows[0].id),status:String(job.rows[0].status),recipient};
}
