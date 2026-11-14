"use client";

import {useEffect,useRef} from "react";
import type {ConversationChangedEvent} from "./conversation-types";

export function useConversationFeed({
  enabled,
  getWebSocketUrl,
  onConversationIds,
  onReconcile,
}:{
  enabled:boolean;
  getWebSocketUrl:()=>Promise<string>;
  onConversationIds:(ids:string[])=>void|Promise<void>;
  onReconcile:()=>void|Promise<void>;
}):void{
  const callbacks=useRef({getWebSocketUrl,onConversationIds,onReconcile});
  useEffect(()=>{callbacks.current={getWebSocketUrl,onConversationIds,onReconcile};});
  useEffect(()=>{
    if(!enabled)return;
    let stopped=false;
    let socket:WebSocket|undefined;
    let reconnectTimer:number|undefined;
    let batchTimer:number|undefined;
    let attempt=0;
    let connected=false;
    let reconciling=false;
    let lastReconcile=Date.now();
    const pending=new Set<string>();
    const reconcile=async()=>{
      if(stopped||reconciling)return;
      reconciling=true;
      try{await callbacks.current.onReconcile();lastReconcile=Date.now();}
      catch{connected=false;}
      finally{reconciling=false;}
    };
    const flush=()=>{
      batchTimer=undefined;
      const ids=[...pending];pending.clear();
      if(ids.length)void Promise.resolve(callbacks.current.onConversationIds(ids)).catch(()=>{connected=false;});
    };
    const schedule=()=>{
      if(stopped||reconnectTimer)return;
      const delay=Math.min(30_000,500*2**Math.min(attempt++,6));
      reconnectTimer=window.setTimeout(()=>{reconnectTimer=undefined;void connect();},delay);
    };
    const connect=async()=>{
      try{
        const url=await callbacks.current.getWebSocketUrl();
        if(stopped)return;
        socket=new WebSocket(url);
        socket.addEventListener("open",()=>{attempt=0;});
        socket.addEventListener("message",event=>{
          try{
            const frame=JSON.parse(String(event.data)) as Partial<Omit<ConversationChangedEvent,"type">>&{type?:string};
            if(frame.type==="events.ready"){connected=true;void reconcile();return;}
            if(frame.type!=="conversation.changed"||typeof frame.conversationId!=="string")return;
            pending.add(frame.conversationId);
            if(!batchTimer)batchTimer=window.setTimeout(flush,100);
          }catch{}
        });
        socket.addEventListener("close",()=>{connected=false;schedule();});
        socket.addEventListener("error",()=>socket?.close());
      }catch{connected=false;schedule();}
    };
    void connect();
    // 实时连接不可用时缩短兜底等待，正常连接仍保持低频校准。
    const reconcileTimer=window.setInterval(()=>{if(!connected||Date.now()-lastReconcile>=60_000)void reconcile();},5000);
    const online=()=>{socket?.close();};
    const visible=()=>{if(document.visibilityState==="visible")void reconcile();};
    window.addEventListener("online",online);
    document.addEventListener("visibilitychange",visible);
    return()=>{
      stopped=true;
      window.removeEventListener("online",online);
      document.removeEventListener("visibilitychange",visible);
      window.clearInterval(reconcileTimer);
      if(reconnectTimer)window.clearTimeout(reconnectTimer);
      if(batchTimer)window.clearTimeout(batchTimer);
      socket?.close(1000,"feed_disposed");
    };
  },[enabled]);
}
