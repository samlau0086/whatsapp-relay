"use client";

import {useEffect,useRef,useState} from "react";
import {authorizedFetch} from "./auth-session";
import {emailHtmlDocument,type EmailInlineImage} from "./email-html-document";

type Attachment={id:string;contentId?:string;mime:string;inline?:boolean};
export function EmailHtmlBody({html,attachments,token,onToken,onReady}:{html:string;attachments:Attachment[];token:string;onToken:(token:string)=>void;onReady:()=>void}) {
  const frame=useRef<HTMLIFrameElement>(null),tokenRef=useRef(token),onTokenRef=useRef(onToken),onReadyRef=useRef(onReady);
  const [images,setImages]=useState<EmailInlineImage[]>([]),[height,setHeight]=useState(160),[imageError,setImageError]=useState(false);
  tokenRef.current=token;onTokenRef.current=onToken;onReadyRef.current=onReady;
  useEffect(()=>{
    let cancelled=false;const urls:string[]=[];const controller=new AbortController();
    setImages([]);setImageError(false);
    void Promise.all(attachments.filter(item=>item.inline&&item.contentId&&item.mime.startsWith("image/")).map(async item=>{
      try{
        const result=await authorizedFetch(`/api/v1/media/${item.id}`,tokenRef.current,{signal:controller.signal});
        if(result.token!==tokenRef.current){tokenRef.current=result.token;onTokenRef.current(result.token);}
        if(!result.response.ok)throw new Error("inline_image_unavailable");
        const url=URL.createObjectURL(await result.response.blob());urls.push(url);
        return {contentId:item.contentId,url};
      }catch{if(!cancelled)setImageError(true);return null;}
    })).then(values=>{if(!cancelled)setImages(values.filter(value=>value!==null));else urls.forEach(URL.revokeObjectURL);});
    return()=>{cancelled=true;controller.abort();urls.forEach(URL.revokeObjectURL);};
  },[html,attachments]);
  useEffect(()=>{
    const element=frame.current;if(!element)return;
    let observer:ResizeObserver|undefined;
    const measure=()=>{const body=element.contentDocument?.body;if(body){const next=Math.min(12000,Math.max(120,Math.ceil(body.getBoundingClientRect().height)+16));setHeight(previous=>previous===next?previous:next);onReadyRef.current();}};
    const loaded=()=>{observer?.disconnect();const body=element.contentDocument?.body;if(body){observer=new ResizeObserver(measure);observer.observe(body);}measure();};
    element.addEventListener("load",loaded);loaded();
    return()=>{element.removeEventListener("load",loaded);observer?.disconnect();};
  },[html,images]);
  return <div className="email-html-body"><iframe ref={frame} className="email-html-frame" title="邮件正文" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={emailHtmlDocument(html,images)} style={{height}}/>{imageError&&<small>部分内嵌图片加载失败，请稍后重新打开邮件。</small>}</div>;
}
