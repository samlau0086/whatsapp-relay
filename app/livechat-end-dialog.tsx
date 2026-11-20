"use client";

import {useRef,useState} from "react";
import {CircleStop} from "lucide-react";
import {Button,Dialog,FormField} from "./ui";
import {authorizedFetch} from "./auth-session";
import type {TimelineRecipient} from "./timeline-recipient";

export function LivechatEndDialog({conversationId,members,initialRecipientId,token,onToken,onClose,onEnded}:{conversationId:string;members:TimelineRecipient[];initialRecipientId:string;token:string;onToken:(token:string)=>void;onClose:()=>void;onEnded:()=>void}){
  const [targetId,setTargetId]=useState(()=>members.some(item=>item.id===initialRecipientId)?initialRecipientId:members[0]?.id??"");
  const [busy,setBusy]=useState(false),[error,setError]=useState("");
  const locked=useRef(false),cancel=useRef<HTMLButtonElement>(null),ids=useRef(new Map<string,string>());
  async function endChat(){
    if(locked.current||!members.some(item=>item.id===targetId))return;
    locked.current=true;setBusy(true);setError("");
    const key=`relayLivechatEnd:${conversationId}:${targetId}`;
    try{
      let id=ids.current.get(key);
      if(!id){try{id=sessionStorage.getItem(key)??undefined;}catch{}}
      id??=crypto.randomUUID();ids.current.set(key,id);
      try{sessionStorage.setItem(key,id);}catch{}
      const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/end-chat`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clientRequestId:id,targetConversationId:targetId})});
      if(result.token!==token)onToken(result.token);
      const body=await result.response.json().catch(()=>({})) as {message?:string;error?:string};
      if(!result.response.ok)throw new Error(body.message??body.error??"结束会话失败");
      ids.current.delete(key);try{sessionStorage.removeItem(key);}catch{}
      onEnded();onClose();
    }catch(reason){setError(reason instanceof Error?reason.message:"结束会话失败");}
    finally{locked.current=false;setBusy(false);}
  }
  return <Dialog open title="结束会话" initialFocus={cancel} busy={busy} onRequestClose={onClose}
    footer={<>{error&&<p className="rd-field-error" role="alert">{error}</p>}<button ref={cancel} type="button" className="rd-button" disabled={busy} onClick={onClose}>取消</button><Button variant="danger" icon={CircleStop} loading={busy} disabled={!targetId} onClick={()=>void endChat()}>确认结束</Button></>}>
    <FormField label="结束对象">{props=><select {...props} value={targetId} onChange={event=>{setTargetId(event.target.value);setError("");}}>{members.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>}</FormField>
    <p>确认结束所选访客的 LiveChat 会话？聊天记录将保留，本次不会发送邮件。</p>
  </Dialog>;
}
