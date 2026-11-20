import type {PoolClient} from "pg";
import {resolveEmailProvider} from "./email-provider-routing.js";
import {defaultTranscriptTemplate,renderTranscript} from "./livechat-transcript-template.js";

export async function queueLivechatTranscript(client:PoolClient,row:{conversation_id:string;account_id:string;contact_id:string;recipient_email:string|null},clientSendId:string,senderUserId:string|null=null,ending=false,endRequestId?:string){
  const recipient=String(row.recipient_email??"").trim();
  if(!recipient)throw Object.assign(new Error("visitor_email_required"),{statusCode:409});
  const provider=await resolveEmailProvider(client,row.account_id);
  if(!provider)throw Object.assign(new Error("email_provider_not_configured"),{statusCode:409});
  const context=await client.query(`SELECT cv.created_at,cv.closed_at,cv.status,co.display_name visitor_name,u.display_name agent_name,
    a.display_name channel_name,c.icon_url,c.transcript_template,clock_timestamp() snapshot_at
    FROM conversations cv JOIN contacts co ON co.id=cv.contact_id
    JOIN livechat_channels c ON c.account_id=cv.account_id JOIN channel_accounts a ON a.id=cv.account_id
    LEFT JOIN users u ON u.id=cv.assigned_user_id WHERE cv.id=$1 AND cv.account_id=$2`,[row.conversation_id,row.account_id]);
  const details=context.rows[0]??{};
  const boundaries=await client.query(`SELECT request_id,created_at::text FROM livechat_end_requests WHERE conversation_id=$1 ORDER BY created_at DESC,request_id DESC`,[row.conversation_id]);
  const ends=boundaries.rows;
  const selected=endRequestId?ends.findIndex(item=>item.request_id===endRequestId):!ending&&details.status==='closed'&&ends.length?0:-1;
  if(endRequestId&&selected<0)throw Object.assign(new Error('transcript_boundary_not_found'),{statusCode:404});
  const upper=selected>=0?ends[selected].created_at:null;
  const lower=ends[selected>=0?selected+1:0]?.created_at??null;
  const template={...defaultTranscriptTemplate,...details.transcript_template};
  // 仅导出原访客已接收、已发布的消息，不包含邮件气泡或合并时间线的其他访客。
  const messages=await client.query(`SELECT m.direction,m.kind,m.text_content,m.occurred_at,media.file_name,u.display_name sender_name
    FROM messages m LEFT JOIN media ON media.id=m.media_id LEFT JOIN users u ON u.id=m.sender_user_id WHERE m.conversation_id=$1
    AND m.livechat_end_request_id IS NULL
    AND ($2::timestamptz IS NULL OR m.occurred_at>$2::timestamptz)
    AND ($3::timestamptz IS NULL OR m.occurred_at<=$3::timestamptz)
    AND NOT EXISTS(SELECT 1 FROM message_email_details d WHERE d.message_id=m.id)
    AND (m.direction='in' OR m.status IN ('sent','delivered','read')) ORDER BY m.occurred_at,m.id`,[row.conversation_id,lower,upper]);
  const iso=(value:unknown)=>value?(value instanceof Date?value:new Date(String(value))).toISOString():'';
  const started=iso(lower?messages.rows[0]?.occurred_at??lower:details.created_at??messages.rows[0]?.occurred_at);
  const end=iso(upper??(ending?details.snapshot_at??new Date():details.status==='closed'?details.closed_at:null));
  const until=end||iso(details.snapshot_at??new Date());
  const seconds=started?Math.max(0,Math.floor((Date.parse(until)-Date.parse(started))/1000)):0;
  const {subject,text,html}=renderTranscript(template,{
    visitor:{name:details.visitor_name||'Visitor',email:recipient},
    conversation:{id:row.conversation_id,startedAt:started,endedAt:end,duration:[Math.floor(seconds/3600),Math.floor(seconds%3600/60),seconds%60].map(value=>String(value).padStart(2,'0')).join(':')},
    agent:{name:details.agent_name||''},department:{name:template.departmentName},
    channel:{name:details.channel_name||'LiveChat',logo:details.icon_url||''},
    messages:messages.rows.map(item=>({body:item.text_content||(!item.file_name?'[Message]':''),time:iso(item.occurred_at),attachments:item.file_name?[String(item.file_name)]:[],direction:item.direction,sender:item.direction==='in'?details.visitor_name||'Visitor':item.sender_name||details.agent_name||details.channel_name||'Support'})),
  });
  const job=await client.query(`INSERT INTO email_messages(client_send_id,conversation_id,contact_id,sender_user_id,provider,provider_config,provider_secret_encrypted,recipients,subject,message_body,text_body,html_body,content_type,livechat_end_request_id)
    VALUES($1,$2,$3,$11,$4,$5,$6,$7,$8,'',$9,$10,'livechat_transcript',$12) RETURNING id,status`,[clientSendId,row.conversation_id,row.contact_id,provider.provider,JSON.stringify(provider.config),provider.secret_encrypted,JSON.stringify([{email:recipient,label:"LiveChat visitor"}]),subject,text,html,senderUserId,endRequestId??null]);
  const bubble=await client.query("INSERT INTO messages(conversation_id,account_id,client_message_id,direction,kind,text_content,status,occurred_at) VALUES($1,$2,$3,'out','text',$4,'queued',now()) RETURNING id",[row.conversation_id,row.account_id,'email:'+job.rows[0].id,text]);
  await client.query("INSERT INTO message_email_details(message_id,subject,from_email,to_emails,rfc_message_id,email_job_id) VALUES($1,$2,$3,$4,$5,$6)",[bubble.rows[0].id,subject,provider.config.fromEmail,JSON.stringify([recipient]),'<email-'+job.rows[0].id+'@relaydesk.local>',job.rows[0].id]);
  return {emailId:String(job.rows[0].id),status:String(job.rows[0].status),recipient};
}
