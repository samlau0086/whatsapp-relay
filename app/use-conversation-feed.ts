"use client";

import {useEffect,useRef} from "react";
import type {ConversationChangedEvent} from "./conversation-types";

export function useConversationFeed({
  enabled,
  getWebSocketUrl,
  onConversationIds,
  onConnected,
  onReconcile,
}:{
  enabled:boolean;
  getWebSocketUrl:()=>Promise<string>;
  onConversationIds:(ids:string[])=>void|Promise<void>;
  onConnected:()=>void|Promise<void>;
  onReconcile:()=>void|Promise<void>;
}):void{
  const callbacks=useRef({getWebSocketUrl,onConversationIds,onConnected,onReconcile});
  useEffect(()=>{callbacks.current={getWebSocketUrl,onConversationIds,onConnected,onReconcile};});
  useEffect(()=>{
    if(!enabled)return;
    let stopped=false;
    let socket:WebSocket|undefined;
    let reconnectTimer:number|undefined;
    let batchTimer:number|undefined;
    let attempt=0;
    const pending=new Set<string>();
    const flush=()=>{
      batchTimer=undefined;
      const ids=[...pending];pending.clear();
      if(ids.length)void callbacks.current.onConversationIds(ids);
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
        socket.addEventListener("open",()=>{attempt=0;void callbacks.current.onConnected();});
        socket.addEventListener("message",event=>{
          try{
            const frame=JSON.parse(String(event.data)) as Partial<ConversationChangedEvent>;
            if(frame.type!=="conversation.changed"||typeof frame.conversationId!=="string")return;
            pending.add(frame.conversationId);
            if(!batchTimer)batchTimer=window.setTimeout(flush,100);
          }catch{}
        });
        socket.addEventListener("close",schedule);
        socket.addEventListener("error",()=>socket?.close());
      }catch{schedule();}
    };
    void connect();
    const reconcile=window.setInterval(()=>void callbacks.current.onReconcile(),60_000);
    const online=()=>{socket?.close();};
    window.addEventListener("online",online);
    return()=>{
      stopped=true;
      window.removeEventListener("online",online);
      window.clearInterval(reconcile);
      if(reconnectTimer)window.clearTimeout(reconnectTimer);
      if(batchTimer)window.clearTimeout(batchTimer);
      socket?.close(1000,"feed_disposed");
    };
  },[enabled]);
}
