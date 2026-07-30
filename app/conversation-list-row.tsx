"use client";

import {ArrowDownLeft,ArrowUpRight,Bell,Facebook,Mail,MessageCircle} from "lucide-react";
import type {MouseEvent} from "react";
import {formatMessageTime,formatMessageTimeTitle} from "./message-time";
import type {Conversation} from "./conversation-types";

const stages:Record<string,string>={new:"新线索",considering:"考虑中",qualified:"已确认",won:"已成交",lost:"已流失"};
const stageValue=(value:string)=>value in stages?value:"new";
const statusClass=(status:Conversation["lastMessageStatus"])=>status==="delivered"||status==="read"?"delivered":status==="failed"?"failed":status==="uncertain"||status==="queued"||status==="dispatching"?"uncertain":"sent";
const statusText=(status:Conversation["lastMessageStatus"])=>status==="delivered"||status==="read"?"已送达":status==="failed"?"发送失败":status==="uncertain"||status==="queued"||status==="dispatching"?"待确认":"已发送";
const dateTime=(value:string)=>{const date=new Date(value);return Number.isNaN(date.getTime())?"":date.toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});};
const reminderState=(value:string,clock:number)=>{
  const dueAt=new Date(value).getTime();
  if(dueAt<=clock)return{className:"overdue",label:"已过期"};
  const now=new Date(clock),tomorrow=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1).getTime();
  return dueAt<tomorrow?{className:"today",label:"今天"}:{className:"upcoming",label:"3 天内"};
};

export function ConversationListRow({item,active,clock,markingUnreadId,onSelect,onMenu,onMarkUnread}:{item:Conversation;active:boolean;clock:number;markingUnreadId:string;onSelect:()=>void;onMenu:(event:MouseEvent)=>void;onMarkUnread:()=>void}){
  const lastMessageTime=item.lastMessageAt?formatMessageTime(item.lastMessageAt,new Date(clock)):item.time;
  return <div role="button" tabIndex={0} onClick={onSelect} onContextMenu={onMenu} onKeyDown={event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect();}}} className={active?"conversation active":"conversation"} title="右键打开客户快捷操作">
    <span className="avatar" style={{background:item.color}}>{item.initials}<i className={`presence ${item.accountStatus==="online"?"online":"offline"}`}/></span>
    <span className="conversation-copy"><span className="conversation-line"><b>{item.name}</b><time dateTime={item.lastMessageAt??undefined} title={item.lastMessageAt?formatMessageTimeTitle(item.lastMessageAt):undefined}>{lastMessageTime}</time></span>
      <span className="conversation-line preview">{item.lastDirection&&<i className={`conversation-direction ${item.lastDirection}${item.lastDirection==="out"?` ${statusClass(item.lastMessageStatus)}`:""}`} role="img" aria-label={item.lastDirection==="in"?"最后一条消息为接收":`最后一条消息为发送，${statusText(item.lastMessageStatus)}`} title={item.lastDirection==="in"?"接收":statusText(item.lastMessageStatus)}>{item.lastDirection==="in"?<ArrowDownLeft size={13}/>:<ArrowUpRight size={13}/>}</i>}<span>{item.preview}</span>{item.unread>0&&<em>{item.unread}</em>}</span>
      <small className="conversation-meta"><span className={`channel-badge ${item.platform}`}>{item.platform==="messenger"?<Facebook size={10}/>:<MessageCircle size={10}/>} {item.platform==="messenger"?`Facebook · ${item.account}`:`WhatsApp · ${item.account}`}</span><span className={`conversation-stage stage-${stageValue(item.customerStage)}`}>{stages[stageValue(item.customerStage)]}</span>{item.tags.slice(0,1).map(tag=><i key={tag.id} style={{background:tag.color}}>{tag.name}</i>)}{item.remindAt&&(()=>{const state=reminderState(item.remindAt,clock);return <em className={state.className}><Bell size={10}/>{state.label} · {dateTime(item.remindAt)}</em>;})()}</small>
    </span>
    {item.unread===0&&<button className="mark-unread-button" disabled={markingUnreadId===item.id} onClick={event=>{event.stopPropagation();onMarkUnread();}} aria-label={`将 ${item.name} 标记为未读`} title="标记为未读"><Mail size={15}/></button>}
  </div>;
}
