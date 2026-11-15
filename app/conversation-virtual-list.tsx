"use client";

import type {MouseEvent} from "react";
import {ConversationListRow} from "./conversation-list-row";
import type {Conversation} from "./conversation-types";

export function ConversationVirtualList({
  items,rows,totalSize,effectiveActiveId,selectedIds,selectionAccountId,clock,markingUnreadId,measure,onSelect,onMenu,onMarkUnread,
}:{
  items:Conversation[];
  rows:Array<{index:number;start:number}>;
  totalSize:number;
  effectiveActiveId:string;
  selectedIds:Set<string>;
  selectionAccountId:string;
  clock:number;
  markingUnreadId:string;
  measure:(element:HTMLDivElement|null)=>void;
  onSelect:(id:string,shiftKey:boolean)=>void;
  onMenu:(event:MouseEvent,item:Conversation)=>void;
  onMarkUnread:(id:string)=>void;
}){
  return <div className="conversation-virtual-list" style={{height:totalSize}}>
    {rows.map(row=>{
      const item=items[row.index];
      return <div key={item.id} data-index={row.index} ref={measure} className="conversation-virtual-row" style={{transform:`translateY(${row.start}px)`}}>
        <ConversationListRow item={item} active={item.id===effectiveActiveId} selected={selectedIds.has(item.id)} multiSelect={selectedIds.size>0} selectionDisabled={Boolean(selectionAccountId&&(item.accountId!==selectionAccountId||item.conversationType==="group"))} clock={clock} markingUnreadId={markingUnreadId} onSelect={shiftKey=>onSelect(item.id,shiftKey)} onMenu={event=>onMenu(event,item)} onMarkUnread={()=>onMarkUnread(item.id)}/>
      </div>;
    })}
  </div>;
}
