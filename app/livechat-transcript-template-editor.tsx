"use client";
import {useRef,useState} from "react";
import {RotateCcw} from "lucide-react";
import {Button} from "./ui/button";
import {FormField} from "./ui/form-field";
import {defaultTranscriptTemplate,renderTranscript,transcriptTemplateError,transcriptVariables,type TranscriptTemplate,type TranscriptContext} from "../services/api/src/livechat-transcript-template";

export function LivechatTranscriptTemplateEditor({value,onChange,channelName,logo}:{value:TranscriptTemplate;onChange:(value:TranscriptTemplate)=>void;channelName:string;logo:string}){
  const [target,setTarget]=useState<'subject'|'body'|'message'>('body');
  const fields=useRef<Partial<Record<'subject'|'body'|'message',HTMLInputElement|HTMLTextAreaElement|null>>>({});
  const error=transcriptTemplateError(value);
  const fixture:TranscriptContext={visitor:{name:'John Smith',email:'john@example.com'},conversation:{id:'demo-conversation',startedAt:'2026-11-20T10:32:00.000Z',endedAt:'2026-11-20T10:36:00.000Z',duration:'00:04:00'},agent:{name:'Alex'},department:{name:value.departmentName},channel:{name:channelName||'Belaro Precision',logo},messages:[
    {direction:'in',sender:'John Smith',time:'10:32 AM',body:"Hi, I'm looking for a CNC machining supplier for aluminum components. Can you handle small batch orders?",attachments:[]},
    {direction:'out',sender:'Alex',time:'10:33 AM',body:'Hello John, Thank you for contacting Belaro Precision.\nYes, we support low-volume CNC machining orders, including custom aluminum components manufactured according to your drawings.',attachments:[]},
    {direction:'in',sender:'John Smith',time:'10:35 AM',body:'Great. What file formats do you accept for quotations?',attachments:['drawing.step','dimensions.pdf']},
    {direction:'out',sender:'Alex',time:'10:36 AM',body:'We accept STEP, STP, IGES, X_T, and other common CAD formats. You can also send us technical drawings in PDF or DWG format.',attachments:[]},
  ]};
  const preview=error?null:renderTranscript(value,fixture);
  function insert(key:string){
    if(!key)return;
    const field=fields.current[target],text='{{'+key+'}}',start=field?.selectionStart??value[target].length,end=field?.selectionEnd??start;
    onChange({...value,[target]:value[target].slice(0,start)+text+value[target].slice(end)});
    requestAnimationFrame(()=>{field?.focus();field?.setSelectionRange(start+text.length,start+text.length);});
  }
  return <section className="rd-transcript-editor livechat-editor-wide" aria-label="会话记录邮件模板">
    <header><h3>会话记录邮件模板</h3><Button icon={RotateCcw} size="compact" onClick={()=>onChange({...defaultTranscriptTemplate})}>恢复默认模板</Button></header>
    <FormField label="客服部门">{props=><input {...props} maxLength={100} value={value.departmentName} onChange={e=>onChange({...value,departmentName:e.target.value})}/>}</FormField>
    <FormField label="邮件主题" required>{props=><input {...props} ref={el=>{fields.current.subject=el;}} maxLength={200} value={value.subject} onFocus={()=>setTarget('subject')} onChange={e=>onChange({...value,subject:e.target.value})}/>}</FormField>
    <FormField label="邮件正文" required>{props=><textarea {...props} ref={el=>{fields.current.body=el;}} rows={10} maxLength={20000} value={value.body} onFocus={()=>setTarget('body')} onChange={e=>onChange({...value,body:e.target.value})}/>}</FormField>
    <FormField label="单条消息格式" required>{props=><textarea {...props} ref={el=>{fields.current.message=el;}} rows={3} maxLength={5000} value={value.message} onFocus={()=>setTarget('message')} onChange={e=>onChange({...value,message:e.target.value})}/>}</FormField>
    <FormField label={'插入变量 · '+({subject:'邮件主题',body:'邮件正文',message:'单条消息格式'}[target])}>{props=><select {...props} value="" onChange={e=>insert(e.target.value)}><option value="">选择变量</option>{transcriptVariables.filter(([key])=>key.startsWith('message.')?target==='message':key==='messages'||key==='channel.logo'?target==='body':true).map(([key,label])=><option key={key} value={key}>{label+' {{'+key+'}}'}</option>)}</select>}</FormField>
    {error&&<p className="rd-transcript-error" role="alert">{error}</p>}
    <details><summary>邮件预览（测试数据）</summary>{preview&&<><output className="rd-transcript-subject">{preview.subject}</output><iframe title="会话记录邮件预览" sandbox="" referrerPolicy="no-referrer" srcDoc={preview.html}/></>}</details>
  </section>;
}
