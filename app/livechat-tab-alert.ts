"use client";

import {useCallback,useEffect,useRef} from "react";

export function useLivechatTabAlert(enabled:boolean,playSound:()=>void){
  const alert=useRef<((messageId:string,channelName:string)=>void)|null>(null);
  useEffect(()=>{
    if(!enabled)return;
    const seen=new Set<string>();
    let interval:number|undefined,timeout:number|undefined;
    let originalTitle="",messageTitle="";
    const stop=()=>{
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      if(interval!==undefined&&document.title===messageTitle)document.title=originalTitle;
      interval=timeout=undefined;
    };
    const visibilityChanged=()=>{if(!document.hidden)stop();};
    window.addEventListener("focus",stop);
    document.addEventListener("visibilitychange",visibilityChanged);
    alert.current=(messageId,channelName)=>{
      if(seen.has(messageId))return;
      seen.add(messageId);
      if(seen.size>256)seen.delete(seen.values().next().value!);
      stop();
      originalTitle=document.title;
      messageTitle=`New message from ${channelName}`;
      document.title=messageTitle;
      interval=window.setInterval(()=>{
        if(document.title!==originalTitle&&document.title!==messageTitle){stop();return;}
        document.title=document.title===messageTitle?originalTitle:messageTitle;
      },1000);
      if(!document.hidden&&document.hasFocus())timeout=window.setTimeout(stop,8000);
      playSound();
    };
    return()=>{
      alert.current=null;
      stop();
      window.removeEventListener("focus",stop);
      document.removeEventListener("visibilitychange",visibilityChanged);
    };
  },[enabled,playSound]);
  return useCallback((messageId:string,channelName:string)=>alert.current?.(messageId,channelName),[]);
}
