"use client";

import {useEffect,useState} from "react";
import type {Conversation} from "./conversation-types";
import {initialConversationMode} from "./conversation-modes";

export type LivechatPresence={status:"online"|"away"|"offline";pageUrl:string|null};
const emptyPresence:Record<string,LivechatPresence>={};
export function visitorStatus(item:Conversation):string{
  const mode=initialConversationMode(item);
  return mode==="email"?"unknown":mode==="livechat"?item.visitorPresence?.status??"unknown":item.accountStatus;
}
export function visitorStatusLabel(item:Conversation):string{
  return ({online:"在线",away:"离开",offline:"离线",unknown:"状态未知"} as Record<string,string>)[visitorStatus(item)]??"状态未知";
}

export function useLivechatPresence(ids:string[],enabled:boolean,request:(ids:string[],signal:AbortSignal)=>Promise<Array<LivechatPresence&{contactId:string}>>){
  const key=[...new Set(ids)].sort().join(",");
  const [snapshot,setSnapshot]=useState<{key:string;data:Record<string,LivechatPresence>}>({key:"",data:{}});
  useEffect(()=>{
    if(!enabled||!key)return;
    const controller=new AbortController();let running=false;
    const refresh=async()=>{
      if(running)return;running=true;
      try{
        const data=await request(key.split(","),AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));
        if(!controller.signal.aborted)setSnapshot({key,data:Object.fromEntries(data.map(item=>[item.contactId,item]))});
      }catch{if(!controller.signal.aborted)setSnapshot({key,data:{}});}
      finally{running=false;}
    };
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};
    void refresh();const timer=window.setInterval(()=>void refresh(),5000);
    document.addEventListener("visibilitychange",visible);
    return()=>{controller.abort();window.clearInterval(timer);document.removeEventListener("visibilitychange",visible);};
  },[key,enabled,request]);
  return enabled&&snapshot.key===key?snapshot.data:emptyPresence;
}
