"use client";

import { Check, ImageIcon, LayoutGrid, LoaderCircle, Rows3, Search, Send, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type RequestResult={response:Response;token:string};
type Request=(path:string,init?:RequestInit)=>Promise<RequestResult>;
type MaterialSummary={id:string;name:string;templateName:string;createdAt:string;createdByName:string;pageCount:number;coverMediaId:string|null};
type MaterialAsset={mediaId:string;pageIndex:number;fileName:string;byteSize:number};
type SelectedMaterialAsset=MaterialAsset&{batchId:string};
type SendMode="stitched"|"individual";
type StitchOrientation="vertical"|"horizontal";

export function MaterialLibrarySendDialog({accountId,conversationId,customerName,initialCaption,request,onToken,onClose,onSent}:{accountId:string;conversationId:string;customerName:string;initialCaption:string;request:Request;onToken:(token:string)=>void;onClose:()=>void;onSent:(message:string)=>void}){
  const [items,setItems]=useState<MaterialSummary[]>([]);
  const [selectedBatchId,setSelectedBatchId]=useState("");
  const [assets,setAssets]=useState<MaterialAsset[]>([]);
  const [selectedMediaIds,setSelectedMediaIds]=useState<string[]>([]);
  const [assetCache,setAssetCache]=useState<Record<string,SelectedMaterialAsset>>({});
  const [mode,setMode]=useState<SendMode>("stitched");
  const [orientation,setOrientation]=useState<StitchOrientation>("vertical");
  const [query,setQuery]=useState("");
  const [caption,setCaption]=useState(initialCaption);
  const [loading,setLoading]=useState(true);
  const [detailLoading,setDetailLoading]=useState(false);
  const [sending,setSending]=useState(false);
  const [confirming,setConfirming]=useState(false);
  const [error,setError]=useState("");
  const requestRef=useRef(request),onTokenRef=useRef(onToken);
  const pendingBatchRef=useRef<{id:string;fingerprint:string}|null>(null);
  const defaultSelectionAppliedRef=useRef(false);

  useEffect(()=>{requestRef.current=request;onTokenRef.current=onToken;},[request,onToken]);
  const loadBatches=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const result=await requestRef.current("/api/v1/materials?limit=50");
      onTokenRef.current(result.token);
      const body=await result.response.json().catch(()=>({})) as {data?:Array<Record<string,unknown>>;error?:string};
      if(!result.response.ok||!body.data)throw new Error(body.error??`素材库加载失败（HTTP ${result.response.status}）`);
      const mapped=body.data.map(mapSummary);
      setItems(mapped);
      setSelectedBatchId(current=>mapped.some(item=>item.id===current)?current:(mapped[0]?.id??""));
    }catch(reason){setError(reason instanceof Error?reason.message:"素材库加载失败");}
    finally{setLoading(false);}
  },[]);

  const loadDetail=useCallback(async(id:string)=>{
    if(!id)return;
    setDetailLoading(true);setError("");
    try{
      const result=await requestRef.current(`/api/v1/materials/${id}`);
      onTokenRef.current(result.token);
      const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;
      if(!result.response.ok)throw new Error(String(body.error??`素材图片加载失败（HTTP ${result.response.status}）`));
      const next=Array.isArray(body.assets)?body.assets.map(value=>mapAsset(value as Record<string,unknown>)):[];
      setAssets(next);
      setAssetCache(current=>Object.fromEntries([...Object.entries(current),...next.map(asset=>[asset.mediaId,{...asset,batchId:id}])]));
      if(!defaultSelectionAppliedRef.current&&next[0]){
        defaultSelectionAppliedRef.current=true;
        setSelectedMediaIds([next[0].mediaId]);
      }
    }catch(reason){setAssets([]);setError(reason instanceof Error?reason.message:"素材图片加载失败");}
    finally{setDetailLoading(false);}
  },[]);

  useEffect(()=>{const timer=window.setTimeout(()=>void loadBatches(),0);return()=>window.clearTimeout(timer);},[loadBatches]);
  useEffect(()=>{const timer=window.setTimeout(()=>void loadDetail(selectedBatchId),0);return()=>window.clearTimeout(timer);},[selectedBatchId,loadDetail]);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!sending&&!confirming)onClose();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[sending,confirming,onClose]);

  const visible=useMemo(()=>{const keyword=query.trim().toLowerCase();return keyword?items.filter(item=>`${item.name} ${item.templateName}`.toLowerCase().includes(keyword)):items;},[items,query]);
  const selectedBatch=items.find(item=>item.id===selectedBatchId);
  const selectedAssets=useMemo(()=>{
    const batchOrder=new Map(items.map((item,index)=>[item.id,index]));
    return selectedMediaIds.flatMap(mediaId=>assetCache[mediaId]?[assetCache[mediaId]]:[]).sort((left,right)=>(batchOrder.get(left.batchId)??Number.MAX_SAFE_INTEGER)-(batchOrder.get(right.batchId)??Number.MAX_SAFE_INTEGER)||left.pageIndex-right.pageIndex);
  },[assetCache,items,selectedMediaIds]);
  const selectionOrder=useMemo(()=>new Map(selectedAssets.map((asset,index)=>[asset.mediaId,index+1])),[selectedAssets]);
  const busy=sending||confirming;

  function toggle(mediaId:string){
    setError("");
    if(selectedMediaIds.includes(mediaId)){pendingBatchRef.current=null;setSelectedMediaIds(current=>current.filter(id=>id!==mediaId));return;}
    if(selectedMediaIds.length>=10){setError("一次最多选择 10 张素材图片");return;}
    pendingBatchRef.current=null;setSelectedMediaIds(current=>[...current,mediaId]);
  }

  async function requestJsonWithTimeout(path:string,init:RequestInit,timeoutMs:number){
    const controller=new AbortController(),timer=window.setTimeout(()=>controller.abort(),timeoutMs);
    try{const result=await requestRef.current(path,{...init,signal:controller.signal});onTokenRef.current(result.token);const body=await result.response.json().catch(()=>({})) as Record<string,unknown>;return{result,body};}
    finally{window.clearTimeout(timer);}
  }

  async function waitForBatch(batchId:string){
    const path=`/api/v1/conversations/${conversationId}/materials/batches/${encodeURIComponent(batchId)}?accountId=${encodeURIComponent(accountId)}`;
    for(let attempt=0;attempt<5;attempt+=1){
      try{const {result,body}=await requestJsonWithTimeout(path,{},3_500);if(result.response.ok&&body.committed===true)return true;if(result.response.status>=400&&result.response.status<500&&result.response.status!==404)return false;}catch{}
      if(attempt<4)await new Promise(resolve=>window.setTimeout(resolve,750));
    }
    return false;
  }

  function completeSend(){
    pendingBatchRef.current=null;
    onSent(mode==="stitched"?`${selectedAssets.length} 张素材已拼接并进入发送队列`:`${selectedAssets.length} 张素材已按页码顺序进入发送队列`);
    onClose();
  }

  async function send(){
    if(!selectedAssets.length||busy)return;
    const mediaIds=selectedAssets.map(item=>item.mediaId),materialBatchIds=[...new Set(selectedAssets.map(item=>item.batchId))],fingerprint=JSON.stringify({materialBatchIds,mediaIds,mode,orientation,caption:caption.trim()});
    const pending=pendingBatchRef.current?.fingerprint===fingerprint?pendingBatchRef.current:{id:`material-${crypto.randomUUID()}`,fingerprint};
    pendingBatchRef.current=pending;setSending(true);setConfirming(false);setError("");
    try{
      const {result,body}=await requestJsonWithTimeout(`/api/v1/conversations/${conversationId}/materials/send`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,clientBatchId:pending.id,materialBatchIds,mediaIds,mode,orientation,caption:caption.trim()||undefined})},15_000);
      if(!result.response.ok)throw Object.assign(new Error(materialSendError(body,result.response.status)),{definitive:true});
      completeSend();
    }catch(reason){
      if((reason as {definitive?:boolean}).definitive){setError(reason instanceof Error?reason.message:"素材发送失败");pendingBatchRef.current=null;}
      else{
        setConfirming(true);
        if(await waitForBatch(pending.id))completeSend();
        else setError("发送状态暂未确认，请稍后重试；系统会使用同一批次编号避免重复发送。");
      }
    }finally{setSending(false);setConfirming(false);}
  }

  return <div className="modal-backdrop material-send-backdrop" role="presentation"><section className="material-send-dialog" role="dialog" aria-modal="true" aria-labelledby="material-send-title">
    <header><div className="material-send-heading"><span><LayoutGrid size={20}/></span><div><h2 id="material-send-title">从素材库发送图片</h2><p>多选、拼接或逐张发送给 {customerName}</p></div></div><button className="material-send-close" onClick={onClose} disabled={busy} aria-label="关闭素材库"><X size={18}/></button></header>
    <div className="material-send-body">
      <aside><label className="material-send-search"><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索素材名称或模板" autoFocus/></label><div className="material-send-batches">{loading?<Loading text="正在读取素材库…"/>:visible.length?visible.map(item=>{const selectedCount=selectedAssets.filter(asset=>asset.batchId===item.id).length;return <button key={item.id} className={selectedBatchId===item.id?"active":""} onClick={()=>setSelectedBatchId(item.id)}><MaterialImage mediaId={item.coverMediaId} request={request} onToken={onToken}/><span><b>{item.name}</b><small>{item.templateName} · {item.pageCount} 张</small><small>{item.createdByName||"团队成员"} · {formatDate(item.createdAt)}</small></span>{selectedCount>0&&<em className="material-batch-selected-count">{selectedCount}</em>}</button>}):<div className="material-send-empty"><ImageIcon size={27}/><b>{query?"没有匹配的素材":"素材库还是空的"}</b><span>{query?"换个关键词试试":"请先在产品库生成素材"}</span></div>}</div></aside>
      <main>
        <div className="material-send-selection-head"><div><b>{selectedBatch?.name??"选择一个素材批次"}</b><span>{assets.length?`当前素材库共 ${assets.length} 张，可跨素材库选择最多 10 张`:""}</span></div><span className="material-selected-indicator"><Check size={13}/>已跨库选择 {selectedAssets.length} 张</span></div>
        <div className="material-send-options"><div role="group" aria-label="发送方式"><button className={mode==="stitched"?"active":""} onClick={()=>{setMode("stitched");pendingBatchRef.current=null}}><LayoutGrid size={14}/>拼接发送</button><button className={mode==="individual"?"active":""} onClick={()=>{setMode("individual");pendingBatchRef.current=null}}><Rows3 size={14}/>逐个发送</button></div>{mode==="stitched"&&<div role="group" aria-label="拼接方向"><span>拼接方向</span><button className={orientation==="vertical"?"active":""} onClick={()=>{setOrientation("vertical");pendingBatchRef.current=null}}>竖向</button><button className={orientation==="horizontal"?"active":""} onClick={()=>{setOrientation("horizontal");pendingBatchRef.current=null}}>横向</button></div>}<small>{mode==="stitched"?"按素材库顺序和页码无缝拼接":"按素材库顺序和页码逐张发送，说明仅附第一张"}</small></div>
        <div className="material-send-assets">{detailLoading?<Loading text="正在加载图片…"/>:assets.length?assets.map(asset=>{const selected=selectedMediaIds.includes(asset.mediaId),order=selectionOrder.get(asset.mediaId)??0;return <button key={asset.mediaId} className={selected?"selected":""} onClick={()=>toggle(asset.mediaId)} aria-pressed={selected}><MaterialImage mediaId={asset.mediaId} request={request} onToken={onToken}/><span>第 {asset.pageIndex+1} 张 · {formatBytes(asset.byteSize)}</span>{selected&&<i aria-label={`已选，第 ${order} 张`}><b>{order}</b><Check size={12}/></i>}</button>}):!loading&&<div className="material-send-empty"><ImageIcon size={30}/><b>暂无可发送图片</b><span>请从左侧选择其他素材</span></div>}</div>
      </main>
    </div>
    {error&&<p className="material-send-error">{error}</p>}
    <footer><label>图片说明（可选）<input value={caption} onChange={event=>{setCaption(event.target.value);pendingBatchRef.current=null}} maxLength={65536} placeholder="随图片一起发送的文字"/></label><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" disabled={!selectedAssets.length||busy} onClick={()=>void send()}>{busy?<><LoaderCircle className="spin" size={15}/>{confirming?"正在确认发送状态…":"正在处理…"}</>:<><Send size={15}/>{mode==="stitched"?`拼接并发送 ${selectedAssets.length} 张`:`逐个发送 ${selectedAssets.length} 张`}</>}</button></footer>
  </section></div>;
}

function MaterialImage({mediaId,request,onToken}:{mediaId:string|null;request:Request;onToken:(token:string)=>void}){
  const [image,setImage]=useState<{mediaId:string;url:string}|null>(null);
  const url=image?.mediaId===mediaId?image.url:"";
  const requestRef=useRef(request),onTokenRef=useRef(onToken);
  useEffect(()=>{requestRef.current=request;onTokenRef.current=onToken;},[request,onToken]);
  useEffect(()=>{if(!mediaId)return;const controller=new AbortController();let objectUrl="";void requestRef.current(`/api/v1/media/${mediaId}`,{signal:controller.signal}).then(async result=>{onTokenRef.current(result.token);if(!result.response.ok)return;objectUrl=URL.createObjectURL(await result.response.blob());if(!controller.signal.aborted)setImage({mediaId,url:objectUrl});}).catch(()=>{});return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[mediaId]);
  return url?<img src={url} alt="素材预览"/>:<span className="material-image-placeholder"><ImageIcon size={20}/></span>;
}

function Loading({text}:{text:string}){return <div className="material-send-loading"><LoaderCircle className="spin" size={20}/><span>{text}</span></div>;}
function mapSummary(item:Record<string,unknown>):MaterialSummary{return{id:String(item.id),name:String(item.name),templateName:String(item.template_name??""),createdAt:String(item.created_at??""),createdByName:String(item.created_by_name??""),pageCount:Number(item.page_count??0),coverMediaId:item.cover_media_id?String(item.cover_media_id):null};}
function mapAsset(item:Record<string,unknown>):MaterialAsset{return{mediaId:String(item.mediaId),pageIndex:Number(item.pageIndex??0),fileName:String(item.fileName??"material.png"),byteSize:Number(item.byteSize??0)};}
function materialSendError(body:Record<string,unknown>,status:number){if(body.error==="template_required")return String(body.message??"Cloud API 客户服务窗口已关闭，请改用已审核模板");if(body.error==="material_stitch_too_large")return"拼接图片过大，请减少选择数量";if(body.error==="invalid_material_selection")return"所选图片已变化，请刷新素材后重试";if(body.error==="material_send_batch_conflict")return"发送批次状态冲突，请重新选择后发送";return String(body.message??body.error??`素材发送失败（HTTP ${status}）`);}
function formatDate(value:string){const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"});}
function formatBytes(value:number){if(value<1024)return`${value} B`;if(value<1024*1024)return`${(value/1024).toFixed(1)} KB`;return`${(value/1024/1024).toFixed(1)} MB`;}
