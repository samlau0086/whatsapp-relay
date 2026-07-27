"use client";

import {Menu,RefreshCw,Search} from "lucide-react";
import type {KeyboardEvent,MouseEvent,RefObject} from "react";
import {CONVERSATION_DATE_FILTERS,type ConversationDateFilter} from "./conversation-date-filter";
import type {Conversation} from "./conversation-types";
import {ConversationVirtualList} from "./conversation-virtual-list";

export function ConversationPanel({
  filter,subtitle,query,onQuery,onOpenSidebar,onRefresh,dateFilter,onDateFilter,onDateKeyDown,
  listRef,sentinelRef,items,rows,totalSize,measure,effectiveActiveId,clock,markingUnreadId,onSelect,onMenu,onMarkUnread,
  loading,loadError,hasAccounts,loadingMore,loadMoreError,hasMore,onLoadMore,
}:{
  filter:string;subtitle:string;query:string;onQuery:(value:string)=>void;onOpenSidebar:()=>void;onRefresh:()=>void;
  dateFilter:ConversationDateFilter;onDateFilter:(value:ConversationDateFilter)=>void;onDateKeyDown:(event:KeyboardEvent<HTMLButtonElement>)=>void;
  listRef:RefObject<HTMLDivElement|null>;sentinelRef:RefObject<HTMLDivElement|null>;items:Conversation[];rows:Array<{index:number;start:number}>;totalSize:number;
  measure:(element:HTMLDivElement|null)=>void;
  effectiveActiveId:string;clock:number;markingUnreadId:string;onSelect:(id:string)=>void;onMenu:(event:MouseEvent,item:Conversation)=>void;onMarkUnread:(id:string)=>void;
  loading:boolean;loadError:string;hasAccounts:boolean;loadingMore:boolean;loadMoreError:string;hasMore:boolean;onLoadMore:()=>void;
}){
  return <section className="conversation-panel">
    <header className="conversation-head">
      <button className="mobile-menu" onClick={onOpenSidebar} aria-label="打开筛选"><Menu size={18}/></button>
      <div><h2>{filter}</h2><span>{subtitle}</span></div>
      <button className="icon-button" onClick={onRefresh} aria-label="刷新"><RefreshCw size={17}/></button>
    </header>
    <label className="search-box"><Search size={15}/><input value={query} onChange={event=>onQuery(event.target.value)} maxLength={100} placeholder="搜索会话、联系人或号码"/></label>
    <div className="conversation-date-tabs" role="tablist" aria-label="按最后联系时间筛选会话">
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

function PanelEmpty({title,text}:{title:string;text:string}){return <div className="empty-state"><b>{title}</b><span>{text}</span></div>;}
