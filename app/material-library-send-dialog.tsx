"use client";

import { Check, ImageIcon, LayoutGrid, LoaderCircle, Search, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

type RequestResult={response:Response;token:string};
type Request=(path:string,init?:RequestInit)=>Promise<RequestResult>;
type MaterialSummary={id:string;name:string;templateName:string;createdAt:string;createdByName:string;pageCount:number;coverMediaId:string|null};
type MaterialAsset={mediaId:string;pageIndex:number;fileName:string;byteSize:number};
type MediaAsset={id:string;fileName:string;mimeType:string;size:number;sha256:string;createdAt:string;usageCount:number};

export function MaterialLibrarySendDialog({customerName,initialCaption,request,onToken,onClose,onSend}:{customerName:string;initialCaption:string;request:Request;onToken:(token:string)=>void;onClose:()=>void;onSend:(asset:MediaAsset,caption:string)=>Promise<void>}){
  const [items,setItems]=useState<MaterialSummary[]>([]);
  const [selectedBatchId,setSelectedBatchId]=useState("");
  const [assets,setAssets]=useState<MaterialAsset[]>([]);
  const [selectedMediaId,setSelectedMediaId]=useState("");
  const [query,setQuery]=useState("");
  const [caption,setCaption]=useState(initialCaption);
  const [loading,setLoading]=useState(true);
  const [detailLoading,setDetailLoading]=useState(false);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState("");

  const loadBatches=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const result=await request("/api/v1/materials?limit=50");
      onToken(result.token);
      const body=await result.response.json().catch(()=>({})) as {data?:Array<Record<string,unknown>>;error?:string};
      if(!result.response.ok||!body.data)throw new Error(body.error??`素材库加载失败（HTTP ${result.response.status}）`);
      const mapped=body.data.map(mapSummary);
      setItems(mapped);
      setSelectedBatchId(current=>mapped.some(item=>item.id===current)?current:(mapped[0]?.id??""));
    }catch(reason){setError(reason instanceof Error?reason.message:"素材库加载失败");}
    finally{setLoading(false);}
  },[request,onToken]);

  const loadDetail=useCallback(async(id:string)=>{
    if(!id){setAssets([]);return;}
    setDetailLoading(true);setError("");setSelectedMediaId("");
    try{
      const result=await request(`/api/v1/materials/${id}`);
      onToken(result.token);
      const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;
      if(!result.response.ok)throw new Error(String(body.error??`素材图片加载失败（HTTP ${result.response.status}）`));
      const next=Array.isArray(body.assets)?body.assets.map(value=>mapAsset(value as Record<string,unknown>)):[];
      setAssets(next);
      setSelectedMediaId(next[0]?.mediaId??"");
    }catch(reason){setAssets([]);setError(reason instanceof Error?reason.message:"素材图片加载失败");}
    finally{setDetailLoading(false);}
  },[request,onToken]);

  useEffect(()=>{const timer=window.setTimeout(()=>void loadBatches(),0);return()=>window.clearTimeout(timer);},[loadBatches]);
  useEffect(()=>{const timer=window.setTimeout(()=>void loadDetail(selectedBatchId),0);return()=>window.clearTimeout(timer);},[selectedBatchId,loadDetail]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!sending)onClose();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[sending,onClose]);

  const visible=useMemo(()=>{const keyword=query.trim().toLowerCase();return keyword?items.filter(item=>`${item.name} ${item.templateName}`.toLowerCase().includes(keyword)):items;},[items,query]);
  const selectedBatch=items.find(item=>item.id===selectedBatchId);
  const selectedAsset=assets.find(item=>item.mediaId===selectedMediaId);

  async function send(){
    if(!selectedAsset||sending)return;
    setSending(true);setError("");
    try{
      await onSend({id:selectedAsset.mediaId,fileName:selectedAsset.fileName,mimeType:"image/png",size:selectedAsset.byteSize,sha256:"",createdAt:selectedBatch?.createdAt??new Date().toISOString(),usageCount:0},caption.trim());
    }catch(reason){setError(reason instanceof Error?reason.message:"素材发送失败");}
    finally{setSending(false);}
  }

  return <div className="modal-backdrop material-send-backdrop" role="presentation"><section className="material-send-dialog" role="dialog" aria-modal="true" aria-labelledby="material-send-title">
    <header><div className="material-send-heading"><span><LayoutGrid size={20}/></span><div><h2 id="material-send-title">从素材库发送图片</h2><p>选择团队素材，直接发送给 {customerName}</p></div></div><button className="material-send-close" onClick={onClose} disabled={sending} aria-label="关闭素材库"><X size={18}/></button></header>
    <div className="material-send-body">
      <aside><label className="material-send-search"><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索素材名称或模板" autoFocus/></label><div className="material-send-batches">{loading?<Loading text="正在读取素材库…"/>:visible.length?visible.map(item=><button key={item.id} className={selectedBatchId===item.id?"active":""} onClick={()=>setSelectedBatchId(item.id)}><MaterialImage mediaId={item.coverMediaId} request={request} onToken={onToken}/><span><b>{item.name}</b><small>{item.templateName} · {item.pageCount} 张</small><small>{item.createdByName||"团队成员"} · {formatDate(item.createdAt)}</small></span></button>):<div className="material-send-empty"><ImageIcon size={27}/><b>{query?"没有匹配的素材":"素材库还是空的"}</b><span>{query?"换个关键词试试":"请先在产品库生成素材"}</span></div>}</div></aside>
      <main><div className="material-send-selection-head"><div><b>{selectedBatch?.name??"选择一个素材批次"}</b><span>{assets.length?`请选择要发送的图片，共 ${assets.length} 张`:""}</span></div>{selectedAsset&&<span className="material-selected-indicator"><Check size={13}/>已选择第 {selectedAsset.pageIndex+1} 张</span>}</div><div className="material-send-assets">{detailLoading?<Loading text="正在加载图片…"/>:assets.length?assets.map(asset=><button key={asset.mediaId} className={selectedMediaId===asset.mediaId?"selected":""} onClick={()=>setSelectedMediaId(asset.mediaId)} aria-pressed={selectedMediaId===asset.mediaId}><MaterialImage mediaId={asset.mediaId} request={request} onToken={onToken}/><span>第 {asset.pageIndex+1} 张 · {formatBytes(asset.byteSize)}</span>{selectedMediaId===asset.mediaId&&<i><Check size={15}/></i>}</button>):!loading&&<div className="material-send-empty"><ImageIcon size={30}/><b>暂无可发送图片</b><span>请从左侧选择其他素材</span></div>}</div></main>
    </div>
    {error&&<p className="material-send-error">{error}</p>}
    <footer><label>图片说明（可选）<input value={caption} onChange={event=>setCaption(event.target.value)} maxLength={65536} placeholder="随图片一起发送的文字"/></label><button className="secondary-action" onClick={onClose} disabled={sending}>取消</button><button className="primary-action" disabled={!selectedAsset||sending} onClick={()=>void send()}>{sending?<><LoaderCircle className="spin" size={15}/>发送中…</>:<><Send size={15}/>发送所选图片</>}</button></footer>
  </section></div>;
}

function MaterialImage({mediaId,request,onToken}:{mediaId:string|null;request:Request;onToken:(token:string)=>void}){
  const [image,setImage]=useState<{mediaId:string;url:string}|null>(null);
  const url=image?.mediaId===mediaId?image.url:"";
  useEffect(()=>{if(!mediaId)return;const controller=new AbortController();let objectUrl="";void request(`/api/v1/media/${mediaId}`,{signal:controller.signal}).then(async result=>{onToken(result.token);if(!result.response.ok)return;objectUrl=URL.createObjectURL(await result.response.blob());if(!controller.signal.aborted)setImage({mediaId,url:objectUrl});}).catch(()=>{});return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[mediaId,request,onToken]);
  return url?<img src={url} alt="素材预览"/>:<span className="material-image-placeholder"><ImageIcon size={20}/></span>;
}

function Loading({text}:{text:string}){return <div className="material-send-loading"><LoaderCircle className="spin" size={20}/><span>{text}</span></div>;}
function mapSummary(item:Record<string,unknown>):MaterialSummary{return{id:String(item.id),name:String(item.name),templateName:String(item.template_name??""),createdAt:String(item.created_at??""),createdByName:String(item.created_by_name??""),pageCount:Number(item.page_count??0),coverMediaId:item.cover_media_id?String(item.cover_media_id):null};}
function mapAsset(item:Record<string,unknown>):MaterialAsset{return{mediaId:String(item.mediaId),pageIndex:Number(item.pageIndex??0),fileName:String(item.fileName??"material.png"),byteSize:Number(item.byteSize??0)};}
function formatDate(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"});}
function formatBytes(value:number){if(value<1024)return`${value} B`;if(value<1024*1024)return`${(value/1024).toFixed(1)} KB`;return`${(value/1024/1024).toFixed(1)} MB`;}
