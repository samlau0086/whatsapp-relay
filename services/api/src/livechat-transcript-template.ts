export type TranscriptTemplate={subject:string;body:string;message:string;departmentName:string};
export type TranscriptMessage={body:string;time:string;attachments:string[];direction:'in'|'out';sender:string};
export type TranscriptContext={visitor:{name:string;email:string};conversation:{id:string;startedAt:string;endedAt:string;duration:string};agent:{name:string};department:{name:string};channel:{name:string;logo:string};messages:TranscriptMessage[]};
export const defaultTranscriptTemplate:TranscriptTemplate={
  subject:'Your LiveChat transcript',
  body:'{{channel.logo}}\n{{channel.name}}\n\nHello {{visitor.name}},\nHere is your chat transcript.\n\nConversation: {{conversation.id}}\nStarted: {{conversation.startedAt}}\nEnded: {{conversation.endedAt}}\nDuration: {{conversation.duration}}\nSupport: {{agent.name}}\n\n{{messages}}',
  message:'{{message.body}}\n{{message.attachments}}',
  departmentName:'',
};
export const transcriptVariables=[
  ['visitor.name','客户姓名'],['visitor.email','客户邮箱'],['conversation.id','对话 ID'],
  ['conversation.startedAt','开始时间'],['conversation.endedAt','结束时间'],['conversation.duration','对话持续时间'],
  ['agent.name','客服姓名'],['department.name','客服部门'],['messages','聊天记录数组'],
  ['message.body','消息内容'],['message.time','消息时间'],['message.attachments','附件数组'],
  ['channel.name','渠道名称'],['channel.logo','渠道 Logo'],
] as const;
const scalarVariables=transcriptVariables.map(([name])=>name).filter(name=>!name.startsWith('message.')&&name!=='messages'&&name!=='channel.logo');
export function transcriptTemplateError(template:TranscriptTemplate):string|null{
  for(const field of ['subject','body','message'] as const){
    const allowed=new Set<string>([...scalarVariables,...(field==='body'?['messages','channel.logo']:field==='message'?['message.body','message.time','message.attachments']:[])]);
    const source=template[field];
    if(!source.trim())return '模板主题、正文和单条消息格式不能为空';
    let error:string|null=null;
    const rest=source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_,key:string)=>{if(!allowed.has(key))error='字段 '+field+' 不支持变量 {{'+key+'}}';return '';});
    if(error)return error;
    if(rest.includes('{{')||rest.includes('}}'))return '模板变量括号不完整';
  }
  if(!/\{\{\s*messages\s*\}\}/.test(template.body))return '邮件正文必须包含 {{messages}}';
  if(!/\{\{\s*message\.body\s*\}\}/.test(template.message))return '单条消息格式必须包含 {{message.body}}';
  if(/[\r\n]/.test(template.subject))return '邮件主题不能包含换行';
  return null;
}
function escape(value:string):string{return value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)).replace(/\r?\n/g,'<br>');}
function safeLogo(value:string):boolean{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;}catch{return false;}}
export function renderTranscript(template:TranscriptTemplate,context:TranscriptContext):{subject:string;text:string;html:string}{
  const error=transcriptTemplateError(template);if(error)throw new Error(error);
  const values:Record<string,string>={
    'visitor.name':context.visitor.name,'visitor.email':context.visitor.email,
    'conversation.id':context.conversation.id,'conversation.startedAt':context.conversation.startedAt,
    'conversation.endedAt':context.conversation.endedAt,'conversation.duration':context.conversation.duration,
    'agent.name':context.agent.name,'department.name':context.department.name,'channel.name':context.channel.name,
  };
  const replace=(source:string,html:boolean,extra:Record<string,string>={})=>source.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_,key:string)=>extra[key]??(html?escape(values[key]??''):values[key]??''));
  const messageText=(message:TranscriptMessage)=>replace(template.message,false,{'message.body':message.body,'message.time':message.time,'message.attachments':message.attachments.map(name=>'[Attachment: '+name+']').join('\n')}).trim();
  const textMessages=context.messages.map(message=>message.sender+' · '+message.time+'\n'+messageText(message)).join('\n\n');
  // 表格与内联样式兼容邮件客户端，不依赖 flex、外部 CSS 或脚本。
  const htmlMessages='<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#000;color:#eee;table-layout:fixed"><tr><td style="padding:16px"><h2 style="margin:0 0 20px;font-size:18px">Chat History</h2>'+context.messages.map(message=>{
    const outgoing=message.direction==='out';
    return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="table-layout:fixed;margin-bottom:24px"><tr><td align="'+(outgoing?'right':'left')+'" style="font-size:12px;color:#bbb;padding-bottom:6px;overflow-wrap:anywhere;word-break:break-word">'+escape(message.sender)+' · '+escape(message.time)+'</td></tr><tr><td style="'+(outgoing?'padding-left:10%':'padding-right:10%')+'"><div style="padding:12px;border-radius:8px;background:'+(outgoing?'#e9f1f8':'#000')+';color:'+(outgoing?'#111':'#eee')+';font-size:16px;line-height:1.6;overflow-wrap:anywhere;word-break:break-word">'+escape(messageText(message))+'</div></td></tr></table>';
  }).join('')+'</td></tr></table>';
  const logo=safeLogo(context.channel.logo)?'<img src="'+escape(context.channel.logo)+'" alt="'+escape(context.channel.name)+'" width="48" height="48" style="display:block;object-fit:contain">':'';
  const subject=replace(template.subject,false).replace(/[\r\n]+/g,' ').trim().slice(0,200)||defaultTranscriptTemplate.subject;
  const text=replace(template.body,false,{messages:textMessages,'channel.logo':safeLogo(context.channel.logo)?context.channel.logo:''});
  const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0;background:#fff;color:#203129;font-family:Arial,sans-serif;line-height:1.6"><div style="max-width:800px;margin:0 auto;padding:16px;overflow-wrap:anywhere;word-break:break-word">'+replace(escape(template.body),true,{messages:htmlMessages,'channel.logo':logo})+'</div></body></html>';
  return {subject,text,html};
}
