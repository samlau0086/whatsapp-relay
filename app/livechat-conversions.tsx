"use client";

import {useEffect,useRef,useState} from "react";
import {BarChart3,RefreshCw} from "lucide-react";
import {authorizedFetch} from "./auth-session";
import type {TimelineRecipient} from "./timeline-recipient";
import {AsyncState,Button,FormField} from "./ui";

const eventTypes={
  qualify_lead:"合格线索",
  disqualify_lead:"不合格线索",
  working_lead:"正在跟进",
  close_convert_lead:"线索已转化",
  close_unconvert_lead:"线索未转化",
  purchase:"已付款订单",
  custom:"自定义事件",
};
const states:Record<string,string>={
  browser_managed:"由宿主 GTM 处理",queued:"等待回传",sending:"正在回传",sent:"Google 已接收请求",
  uncertain:"结果不确定，未自动重发",failed:"回传失败",skipped_consent:"未取得分析同意或同意已撤回",
  skipped_config:"渠道未配置或配置已变更",skipped_client_id:"未取得有效 GA4 Client ID",
};
type History={id:string;event_name:string;delivery_state:string;created_at:string;order_id:string|null};
type Order={id:string;display_order_number:string;amount:string;currency:string;recorded:boolean};
type ConversionData={data:History[];orders:Order[];canRecord:boolean;analytics:{consent:string;clientIdAvailable:boolean;configured:boolean}};
type Connection={conversationId:string;token:string;onToken:(token:string)=>void;onRecorded:(purchase:boolean)=>void};

export function LivechatConversionsPanel({members,initialRecipientId,...connection}:Connection&{members:TimelineRecipient[];initialRecipientId:string}){
  const [open,setOpen]=useState(false),[selected,setSelected]=useState(""),[busy,setBusy]=useState(false);
  const target=members.find(item=>item.id===selected)?.id??members.find(item=>item.id===initialRecipientId)?.id??members[0]?.id;
  return <section className="rd-livechat-conversions" aria-label="LiveChat 转化事件">
    <Button icon={BarChart3} size="compact" aria-expanded={open} disabled={busy} onClick={()=>{if(!open&&target)setSelected(target);setOpen(!open);}}>转化事件</Button>
    {open&&target&&<>
      {members.length>1&&<FormField label="记录给访客">{props=><select {...props} value={target} disabled={busy} onChange={event=>setSelected(event.target.value)}>{members.map(member=><option key={member.id} value={member.id}>{member.name}</option>)}</select>}</FormField>}
      <ConversionForm key={target} {...connection} target={target} busy={busy} setBusy={setBusy}/>
    </>}
  </section>;
}

function ConversionForm({conversationId,target,token,onToken,onRecorded,busy,setBusy}:Connection&{target:string;busy:boolean;setBusy:(busy:boolean)=>void}){
  const [data,setData]=useState<ConversionData>(),[readError,setReadError]=useState(""),[revision,setRevision]=useState(0);
  const [kind,setKind]=useState<keyof typeof eventTypes>("qualify_lead"),[custom,setCustom]=useState(""),[order,setOrder]=useState("");
  const [writeError,setWriteError]=useState(""),[success,setSuccess]=useState("");
  const submitting=useRef(false);
  const requestIds=useRef(new Map<string,string>());
  const endpoint=`/api/v1/conversations/${conversationId}/livechat-conversions`;
  const hasPending=data?.data.some(item=>item.delivery_state==="queued"||item.delivery_state==="sending")??false;
  useEffect(()=>{
    const abort=new AbortController();
    let reading=false;
    async function load(){
      if(reading)return;reading=true;
      try{
        const response=await authorizedFetch(endpoint+"?targetConversationId="+encodeURIComponent(target),token,{signal:abort.signal});
        const body=await response.response.json();
        if(abort.signal.aborted)return;
        if(response.token!==token)onToken(response.token);
        if(!response.response.ok)throw new Error(body.message??"无法读取转化事件");
        setData(body);setReadError("");
      }catch(error){if(!abort.signal.aborted)setReadError(error instanceof Error?error.message:"无法读取转化事件");}
      finally{reading=false;}
    }
    void load();
    const timer=hasPending?setInterval(()=>void load(),4000):undefined;
    return()=>{abort.abort();clearInterval(timer);};
  },[endpoint,target,token,onToken,revision,hasPending]);
  async function record(){
    if(submitting.current||!data?.canRecord||readError)return;
    const eventName=kind==="custom"?custom.trim():kind;
    const payload={targetConversationId:target,eventName,...(kind==="purchase"?{orderId:order}:{})};
    const key=`relayLivechatConversion:${conversationId}:${target}:${eventName}:${payload.orderId??""}`;
    submitting.current=true;setBusy(true);setWriteError("");setSuccess("");
    try{
      let clientEventId=requestIds.current.get(key);
      if(!clientEventId){try{clientEventId=sessionStorage.getItem(key)??undefined;}catch{}}
      clientEventId??=crypto.randomUUID();
      requestIds.current.set(key,clientEventId);
      try{sessionStorage.setItem(key,clientEventId);}catch{}
      const result=await authorizedFetch(endpoint,token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...payload,clientEventId})});
      const body=await result.response.json();
      if(result.token!==token)onToken(result.token);
      if(!result.response.ok){
        if(body.error==="client_event_id_conflict"){requestIds.current.delete(key);try{sessionStorage.removeItem(key);}catch{}}
        throw new Error(body.message??"记录转化事件失败");
      }
      try{sessionStorage.removeItem(key);}catch{}
      requestIds.current.delete(key);
      setSuccess("已记录："+(states[body.deliveryState]??body.deliveryState));
      setCustom("");setOrder("");setRevision(value=>value+1);
      onRecorded(kind==="purchase");
    }catch(error){setWriteError(error instanceof Error?error.message:"记录转化事件失败");}
    finally{submitting.current=false;setBusy(false);}
  }
  const orders=data?.orders.filter(item=>!item.recorded)??[];
  return <AsyncState status={readError?(data?"partial":"error"):data?"ready":"loading"} message={readError||undefined} onRetry={()=>setRevision(v=>v+1)}>
    {data&&<>
      <div className="rd-livechat-conversions-head">
        <p>{!data.analytics.configured?"未配置 GA4 后台回传，事件只记入工作台。":data.analytics.consent!=="granted"?"未取得访客的分析同意，事件只记入工作台。":!data.analytics.clientIdAvailable?"未取得 GA4 Client ID，事件只记入工作台。":"已取得分析同意及 GA4 Client ID。"}</p>
        <Button icon={RefreshCw} size="compact" onClick={()=>setRevision(v=>v+1)}>刷新状态</Button>
      </div>
      {data.canRecord?<form onSubmit={event=>{event.preventDefault();void record();}}>
        <FormField label="事件类型">{props=><select {...props} value={kind} disabled={busy} onChange={event=>{setKind(event.target.value as keyof typeof eventTypes);setWriteError("");setSuccess("");}}>{Object.entries(eventTypes).map(([value,name])=><option key={value} value={value}>{name}</option>)}</select>}</FormField>
        {kind==="custom"&&<FormField label="自定义事件名" required hint="小写字母开头，仅限小写字母、数字、下划线，请勿填写个人信息。">{props=><input {...props} maxLength={40} pattern="[a-z][a-z0-9_]{0,39}" value={custom} disabled={busy} onChange={event=>setCustom(event.target.value)} placeholder="quote_requested"/>}</FormField>}
        {kind==="purchase"&&<FormField label="已付款订单" required hint={orders.length?"只显示该访客尚未记录的已付款订单。":"该访客暂无可用的已付款订单。"}>{props=><select {...props} value={order} disabled={busy||!orders.length} onChange={event=>setOrder(event.target.value)}><option value="">选择订单</option>{orders.map(item=><option key={item.id} value={item.id}>{item.display_order_number} · {item.currency} {item.amount}</option>)}</select>}</FormField>}
        <Button type="submit" variant="primary" size="compact" loading={busy} disabled={Boolean(readError)||kind==="purchase"&&!orders.some(item=>item.id===order)}>记录事件</Button>
        {writeError&&<p role="alert" className="rd-livechat-conversions-error">{writeError}</p>}
        {success&&<p role="status">{success}</p>}
      </form>:<p>当前渠道不可记录，或你没有该访客所属渠道的发送权限。</p>}
      {data.data.length?<ul aria-label="转化历史">{data.data.map(item=><li key={item.id}>
        <strong>{item.event_name}</strong>{item.order_id&&<span>订单：{data.orders.find(order=>order.id===item.order_id)?.display_order_number??item.order_id}</span>}
        <span>{states[item.delivery_state]??item.delivery_state} · {new Date(item.created_at).toLocaleString()}</span>
      </li>)}</ul>:<p>暂无转化事件。</p>}
    </>}
  </AsyncState>;
}
