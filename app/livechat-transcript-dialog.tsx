"use client";

import {useEffect,useRef,useState} from "react";
import {Mail,RefreshCw,Send,X} from "lucide-react";
import {authorizedFetch} from "./auth-session";
import type {TimelineRecipient} from "./timeline-recipient";

export function LivechatTranscriptDialog({conversationId,accountId,members,initialRecipientId,token,onToken,onClose,onSent}:{conversationId:string;accountId:string;members:TimelineRecipient[];initialRecipientId:string;token:string;onToken:(token:string)=>void;onClose:()=>void;onSent:(text:string)=>void}){
  const [targetId,setTargetId]=useState(()=>members.some(item=>item.id===initialRecipientId)?initialRecipientId:members[0]?.id??"");
  const [recipient,setRecipient]=useState({key:"",email:"",error:""}),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const dialogRef=useRef<HTMLElement>(null),sending=useRef(false),requestIds=useRef(new Map<string,string>());
  const member=members.find(item=>item.id===targetId),contactId=member?.contactId??"";
  const recipientKey=`${accountId}:${contactId}`,loading=recipient.key!==recipientKey;
  useEffect(()=>{
    let cancelled=false;
    void (async()=>{
      try{
        const result=await authorizedFetch(`/api/v1/contacts/${contactId}?accountId=${encodeURIComponent(accountId)}`,token);
        if(result.token!==token)onToken(result.token);
        const body=await result.response.json() as {primaryEmail?:string;message?:string;error?:string};
        if(!result.response.ok)throw new Error(body.message??body.error??"无法读取访客邮箱");
        if(!cancelled)setRecipient({key:recipientKey,email:body.primaryEmail??"",error:""});
      }catch(reason){if(!cancelled)setRecipient({key:recipientKey,email:"",error:reason instanceof Error?reason.message:"无法读取访客邮箱"});}
    })();
    return()=>{cancelled=true;};
  },[contactId,accountId,recipientKey,token,onToken]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    dialogRef.current?.querySelector<HTMLElement>("button,select")?.focus();
    return()=>previous?.focus();
  },[]);
  const email=loading?"":recipient.email,visibleError=error||(!loading?recipient.error:"");
  async function send(){
    if(sending.current||loading||!email||!member)return;
    sending.current=true;setBusy(true);setError("");
    // 网络确认丢失时，重新打开或刷新仍使用原请求 ID；成功后下一次发送才创建新 ID。
    const key=`relayLivechatTranscript:${accountId}:${conversationId}:${targetId}`;
    try{
      let clientSendId=requestIds.current.get(key);
      if(!clientSendId){try{clientSendId=sessionStorage.getItem(key)??undefined;}catch{}}
      clientSendId??=crypto.randomUUID();requestIds.current.set(key,clientSendId);
      try{sessionStorage.setItem(key,clientSendId);}catch{}
      const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/transcript`,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clientSendId,targetConversationId:targetId})});
      if(result.token!==token)onToken(result.token);
      const body=await result.response.json() as {status?:string;message?:string;error?:string};
      if(!result.response.ok){
        if(body.error==="client_send_id_conflict"){try{sessionStorage.removeItem(key);}catch{}requestIds.current.delete(key);}
        throw new Error(body.message??body.error??"会话记录发送失败");
      }
      try{sessionStorage.removeItem(key);}catch{}
      requestIds.current.delete(key);
      onSent(body.status==="accepted"?"会话记录邮件已提交邮件服务商":body.status==="failed"?"该记录邮件发送失败，请在会话中查看状态": "会话记录邮件已入队，请在会话中查看发送状态");
      onClose();
    }catch(reason){setError(reason instanceof Error?reason.message:"会话记录发送失败");}
    finally{sending.current=false;setBusy(false);}
  }
  return <div className="modal-backdrop contact-dialog-backdrop" role="presentation"><section ref={dialogRef} className="login-dialog contact-create-dialog livechat-transcript-dialog" role="dialog" aria-modal="true" aria-labelledby="transcript-title" onKeyDown={event=>{
    if(event.key==="Escape"&&!sending.current){event.stopPropagation();onClose();}
    if(event.key!=="Tab")return;
    const nodes=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled),input:not(:disabled)'));
    const first=nodes[0],last=nodes.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }}>
    <button type="button" className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button>
    <header className="contact-dialog-heading"><span className="login-logo"><Mail size={20}/></span><h2 id="transcript-title">发送会话记录</h2></header>
    <label>访客<select aria-label="记录接收访客" value={targetId} disabled={busy} onChange={event=>{setTargetId(event.target.value);setError("");setRecipient({key:"",email:"",error:""});}}>{members.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <label>收件邮箱<input type="email" aria-label="收件邮箱" value={loading?"":email} readOnly placeholder={loading?"正在读取…":"未设置主邮箱"}/></label>
    {!loading&&!email&&!visibleError&&<span className="login-error">请先在客户资料中设置访客主邮箱</span>}
    {visibleError&&<span className="login-error" role="alert">{visibleError}</span>}
    <footer className="contact-dialog-actions"><button type="button" className="secondary-action" disabled={busy} onClick={onClose}>取消</button><button type="button" className="primary-action" disabled={busy||loading||!email} onClick={()=>void send()}>{busy?<><RefreshCw size={14} className="spin"/>正在提交…</>:<><Send size={14}/>发送记录</>}</button></footer>
  </section></div>;
}
