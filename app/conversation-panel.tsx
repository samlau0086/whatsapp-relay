"use client";

import {Check,ChevronDown,Menu,PanelLeftClose,PanelLeftOpen,RefreshCw,Search,ShoppingCart,Tag,UserRound,X} from "lucide-react";
import {useEffect,useMemo,useRef,useState,type KeyboardEvent,type MouseEvent,type PointerEvent as ReactPointerEvent,type RefObject,type WheelEvent} from "react";
import {CONVERSATION_DATE_FILTERS,type ConversationCustomerStage,type ConversationDateFilter,type ConversationLatestOrderStatus} from "./conversation-date-filter";
import type {Conversation} from "./conversation-types";
import {ConversationVirtualList} from "./conversation-virtual-list";

export function ConversationPanel({
  filter,subtitle,query,onQuery,tags,tagId,onTagId,onTagOpen,customerStage,onCustomerStage,latestOrderStatus,onLatestOrderStatus,onOpenSidebar,collapsed,onToggleCollapsed,onRefresh,dateFilter,onDateFilter,onDateKeyDown,
  listRef,sentinelRef,items,rows,totalSize,measure,effectiveActiveId,clock,markingUnreadId,onSelect,onMenu,onMarkUnread,
  loading,loadError,hasAccounts,loadingMore,loadMoreError,hasMore,onLoadMore,
}:{
  filter:string;subtitle:string;query:string;onQuery:(value:string)=>void;tags:Array<{id:string;name:string;color:string}>;tagId:string;onTagId:(value:string)=>void;onTagOpen:()=>void;onOpenSidebar:()=>void;collapsed:boolean;onToggleCollapsed:()=>void;onRefresh:()=>void;
  customerStage:""|ConversationCustomerStage;onCustomerStage:(value:""|ConversationCustomerStage)=>void;latestOrderStatus:""|ConversationLatestOrderStatus;onLatestOrderStatus:(value:""|ConversationLatestOrderStatus)=>void;
  dateFilter:ConversationDateFilter;onDateFilter:(value:ConversationDateFilter)=>void;onDateKeyDown:(event:KeyboardEvent<HTMLButtonElement>)=>void;
  listRef:RefObject<HTMLDivElement|null>;sentinelRef:RefObject<HTMLDivElement|null>;items:Conversation[];rows:Array<{index:number;start:number}>;totalSize:number;
  measure:(element:HTMLDivElement|null)=>void;
  effectiveActiveId:string;clock:number;markingUnreadId:string;onSelect:(id:string)=>void;onMenu:(event:MouseEvent,item:Conversation)=>void;onMarkUnread:(id:string)=>void;
  loading:boolean;loadError:string;hasAccounts:boolean;loadingMore:boolean;loadMoreError:string;hasMore:boolean;onLoadMore:()=>void;
}){
  const dateTabsRef=useRef<HTMLDivElement>(null);
  const dateTabsDragRef=useRef({pointerId:-1,startX:0,startScrollLeft:0,moved:false});
  const onDateTabsPointerDown=(event:ReactPointerEvent<HTMLDivElement>)=>{
    if(event.pointerType!=="mouse"||event.button!==0)return;
    const element=dateTabsRef.current;
    if(!element||element.scrollWidth<=element.clientWidth)return;
    dateTabsDragRef.current={pointerId:event.pointerId,startX:event.clientX,startScrollLeft:element.scrollLeft,moved:false};
  };
  const onDateTabsPointerMove=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const element=dateTabsRef.current,drag=dateTabsDragRef.current;
    if(!element||drag.pointerId!==event.pointerId)return;
    const distance=event.clientX-drag.startX;
    if(Math.abs(distance)>4&&!drag.moved){
      drag.moved=true;
      element.setPointerCapture(event.pointerId);
      element.classList.add("dragging");
    }
    if(!drag.moved)return;
    event.preventDefault();
    element.scrollLeft=drag.startScrollLeft-distance;
  };
  const finishDateTabsDrag=(event:ReactPointerEvent<HTMLDivElement>)=>{
    const element=dateTabsRef.current,drag=dateTabsDragRef.current;
    if(!element||drag.pointerId!==event.pointerId)return;
    if(element.hasPointerCapture(event.pointerId))element.releasePointerCapture(event.pointerId);
    element.classList.remove("dragging");
    drag.pointerId=-1;
    window.setTimeout(()=>{drag.moved=false;},0);
  };
  const onDateTabsWheel=(event:WheelEvent<HTMLDivElement>)=>{
    const element=dateTabsRef.current;
    if(!element||element.scrollWidth<=element.clientWidth||Math.abs(event.deltaX)>=Math.abs(event.deltaY))return;
    event.preventDefault();
    element.scrollLeft+=event.deltaY;
  };
  return <section className="conversation-panel">
    <header className="conversation-head">
      <button className="mobile-menu" onClick={onOpenSidebar} aria-label="打开筛选"><Menu size={18}/></button>
      <div><h2>{filter}</h2><span>{subtitle}</span></div>
      <button className="icon-button conversation-toggle" onClick={onToggleCollapsed} aria-label={collapsed?"显示会话栏":"隐藏会话栏"} title={collapsed?"显示会话栏":"隐藏会话栏"}>{collapsed?<PanelLeftOpen size={17}/>:<PanelLeftClose size={17}/>}</button>
      <button className="icon-button" onClick={onRefresh} aria-label="刷新"><RefreshCw size={17}/></button>
    </header>
    <label className="search-box"><Search size={15}/><input value={query} onChange={event=>onQuery(event.target.value)} maxLength={100} placeholder="搜索会话、联系人或号码"/></label>
    <ConversationTagFilter tags={tags} value={tagId} onChange={onTagId} onOpen={onTagOpen}/>
    <div className="conversation-attribute-filters">
      <label><UserRound size={14}/><select aria-label="按客户阶段筛选会话" value={customerStage} onChange={event=>onCustomerStage(event.target.value as ""|ConversationCustomerStage)}>
        <option value="">全部客户阶段</option>
        <option value="new">新线索</option><option value="considering">待考量</option><option value="qualified">合格</option><option value="won">已成交</option><option value="lost">已流失</option>
      </select><ChevronDown size={13}/></label>
      <label><ShoppingCart size={14}/><select aria-label="按最新订单状态筛选会话" value={latestOrderStatus} onChange={event=>onLatestOrderStatus(event.target.value as ""|ConversationLatestOrderStatus)}>
        <option value="">全部订单情况</option><option value="none">未创建订单</option><option value="any">已创建订单</option>
        <option value="quotation">报价</option><option value="pending_confirmation">待确认</option><option value="pending_payment">待付款</option><option value="paid">已付款</option><option value="processing">处理中</option><option value="shipped">已发货</option><option value="completed">已完成</option><option value="cancelled">已取消</option>
      </select><ChevronDown size={13}/></label>
    </div>
    <div ref={dateTabsRef} className="conversation-date-tabs" role="tablist" aria-label="按最后联系时间筛选会话" onPointerDown={onDateTabsPointerDown} onPointerMove={onDateTabsPointerMove} onPointerUp={finishDateTabsDrag} onPointerCancel={finishDateTabsDrag} onClickCapture={event=>{if(dateTabsDragRef.current.moved){event.preventDefault();event.stopPropagation();}}} onWheel={onDateTabsWheel}>
      {CONVERSATION_DATE_FILTERS.map(item=><button key={item.value} type="button" role="tab" aria-selected={dateFilter===item.value} tabIndex={dateFilter===item.value?0:-1} className={dateFilter===item.value?"active":""} onClick={()=>onDateFilter(item.value)} onKeyDown={onDateKeyDown}>{item.label}</button>)}
    </div>
    <div className="conversation-list" ref={listRef}>
      {loading?<PanelEmpty title="正在读取中心数据" text="请稍候…"/>:loadError?<PanelEmpty title="中心数据加载失败" text={loadError}/>:items.length?<>
        <ConversationVirtualList items={items} rows={rows} totalSize={totalSize} effectiveActiveId={effectiveActiveId} clock={clock} markingUnreadId={markingUnreadId} measure={measure} onSelect={onSelect} onMenu={onMenu} onMarkUnread={onMarkUnread}/>
        <div ref={sentinelRef} className="conversation-load-sentinel">
          {loadingMore&&<span>正在加载更多会话…</span>}
          {loadMoreError&&<button onClick={onLoadMore}>加载失败，点击重试</button>}
          {!hasMore&&!loadingMore&&<span>已加载全部会话</span>}
        </div>
      </>:<PanelEmpty title="暂无真实会话" text={hasAccounts?"当前筛选条件下暂无会话":"请先在 Windows Agent 绑定 WhatsApp 账号"}/>}
    </div>
  </section>;
}

function ConversationTagFilter({tags,value,onChange,onOpen}:{tags:Array<{id:string;name:string;color:string}>;value:string;onChange:(value:string)=>void;onOpen:()=>void}){
  const rootRef=useRef<HTMLDivElement>(null),inputRef=useRef<HTMLInputElement>(null),openingRef=useRef(false);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(""),[activeIndex,setActiveIndex]=useState(0);
  const selected=tags.find(tag=>tag.id===value);
  const visible=useMemo(()=>{
    const keyword=query.trim().toLocaleLowerCase();
    return keyword?tags.filter(tag=>tag.name.toLocaleLowerCase().includes(keyword)):tags;
  },[query,tags]);
  useEffect(()=>{
    if(!open)return;
    const close=(event:PointerEvent)=>{if(!rootRef.current?.contains(event.target as Node)){openingRef.current=false;setOpen(false);}};
    document.addEventListener("pointerdown",close);
    return()=>document.removeEventListener("pointerdown",close);
  },[open]);
  const show=()=>{setActiveIndex(0);setOpen(true);if(!openingRef.current){openingRef.current=true;onOpen();}};
  const select=(id:string)=>{openingRef.current=false;onChange(id);setQuery("");setActiveIndex(0);setOpen(false);};
  const remove=()=>{openingRef.current=false;onChange("");setQuery("");setActiveIndex(0);setOpen(false);window.requestAnimationFrame(()=>inputRef.current?.focus());};
  const onKeyDown=(event:KeyboardEvent<HTMLInputElement>)=>{
    if(event.key==="Escape"){openingRef.current=false;setOpen(false);return;}
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      event.preventDefault();setOpen(true);
      setActiveIndex(index=>visible.length?(index+(event.key==="ArrowDown"?1:-1)+visible.length)%visible.length:0);
      return;
    }
    if(event.key==="Enter"&&open&&visible[activeIndex]){event.preventDefault();select(visible[activeIndex].id);}
  };
  return <div ref={rootRef} className={`conversation-tag-filter ${open?"open":""} ${selected?"has-value":""}`}>
    <Tag size={15} className="conversation-tag-filter-icon"/>
    {selected?<span className="conversation-tag-chip"><i style={{background:selected.color}}/><b>{selected.name}</b><button type="button" onClick={remove} aria-label={`移除标签 ${selected.name}`}><X size={13}/></button></span>:<input ref={inputRef} value={query} onFocus={show} onClick={show} onChange={event=>{setQuery(event.target.value);setActiveIndex(0);setOpen(true);}} onKeyDown={onKeyDown} role="combobox" aria-label="搜索并筛选会话标签" aria-expanded={open} aria-controls="conversation-tag-options" aria-autocomplete="list" placeholder="搜索标签"/>}
    {!selected&&<ChevronDown size={14} className="conversation-tag-chevron" aria-hidden="true"/>}
    {open&&!selected&&<div id="conversation-tag-options" className="conversation-tag-options" role="listbox">
      <button type="button" role="option" aria-selected={!value} className={!value?"active":""} onMouseDown={event=>event.preventDefault()} onClick={()=>select("")}><span className="conversation-tag-all"><Tag size={14}/></span><b>全部标签</b>{!value&&<Check size={14}/>}</button>
      {visible.map((tag,index)=><button type="button" role="option" aria-selected={value===tag.id} className={index===activeIndex?"focused":""} key={tag.id} onMouseEnter={()=>setActiveIndex(index)} onMouseDown={event=>event.preventDefault()} onClick={()=>select(tag.id)}><i style={{background:tag.color}}/><b>{tag.name}</b>{value===tag.id&&<Check size={14}/>}</button>)}
      {!visible.length&&<p>没有匹配的标签</p>}
    </div>}
  </div>;
}

function PanelEmpty({title,text}:{title:string;text:string}){return <div className="empty-state"><b>{title}</b><span>{text}</span></div>;}
