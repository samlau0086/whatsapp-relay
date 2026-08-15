export type ConversationDateFilter="all"|"today"|"yesterday"|"day3"|"day5"|"day7"|"day15plus"|"unreplied"|"sendFailed";
export type ConversationListFilter="all"|"groups"|"mine"|"unassigned"|"favorite"|"closed"|"archived"|"reminders"|"blocked";
export type ConversationCustomerStage="new"|"considering"|"qualified"|"won"|"lost";
export type ConversationLatestOrderStatus="none"|"any"|"quotation"|"pending_confirmation"|"pending_payment"|"paid"|"processing"|"shipped"|"completed"|"cancelled";
export type ConversationListOptions={filter?:ConversationListFilter;accountId?:string;q?:string;tagId?:string;customerStage?:ConversationCustomerStage;latestOrderStatus?:ConversationLatestOrderStatus;cursor?:string;limit?:number};

export const CONVERSATION_DATE_FILTERS:Array<{value:ConversationDateFilter;label:string}>=[
  {value:"all",label:"全部"},
  {value:"today",label:"今天"},
  {value:"yesterday",label:"昨天"},
  {value:"day3",label:"3天"},
  {value:"day5",label:"5天"},
  {value:"day7",label:"7天"},
  {value:"day15plus",label:"15天及以上"},
  {value:"unreplied",label:"未回复"},
  {value:"sendFailed",label:"发送失败"},
];

export function conversationDateRange(filter:ConversationDateFilter,now=new Date()):{from?:string;before?:string}{
  if(filter==="all"||filter==="unreplied"||filter==="sendFailed")return{};
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
  if(filter==="today")return{from:today.toISOString(),before:tomorrow.toISOString()};
  if(filter==="yesterday"){
    const yesterday=new Date(today);yesterday.setDate(today.getDate()-1);
    return{from:yesterday.toISOString(),before:today.toISOString()};
  }
  const days=filter==="day3"?3:filter==="day5"?5:filter==="day7"?7:15;
  const from=new Date(today);from.setDate(today.getDate()-days);
  const before=new Date(from);before.setDate(from.getDate()+1);
  return filter==="day15plus"?{before:before.toISOString()}:{from:from.toISOString(),before:before.toISOString()};
}

export function conversationListPath(filter:ConversationDateFilter,now=new Date(),options:ConversationListOptions={}):string{
  const params=new URLSearchParams({limit:String(options.limit??40)});
  if(options.filter)params.set("filter",options.filter);
  if(options.accountId)params.set("accountId",options.accountId);
  if(options.q?.trim())params.set("q",options.q.trim());
  if(options.tagId)params.set("tagId",options.tagId);
  if(options.customerStage)params.set("customerStage",options.customerStage);
  if(options.latestOrderStatus)params.set("latestOrderStatus",options.latestOrderStatus);
  if(options.cursor)params.set("cursor",options.cursor);
  if(filter==="unreplied")params.set("unreplied","true");
  if(filter==="sendFailed")params.set("sendFailed","true");
  const range=conversationDateRange(filter,now);
  if(range.from)params.set("lastMessageFrom",range.from);
  if(range.before)params.set("lastMessageBefore",range.before);
  return`/api/v1/conversations?${params.toString()}`;
}

export function conversationCountsPath(filter:ConversationDateFilter,now=new Date(),accountId=""):string{
  const params=new URLSearchParams();
  if(accountId)params.set("accountId",accountId);
  if(filter==="unreplied")params.set("unreplied","true");
  if(filter==="sendFailed")params.set("sendFailed","true");
  const range=conversationDateRange(filter,now);
  if(range.from)params.set("lastMessageFrom",range.from);
  if(range.before)params.set("lastMessageBefore",range.before);
  const suffix=params.toString();
  return`/api/v1/conversations/counts${suffix?`?${suffix}`:""}`;
}

export function conversationSummaryPath(id:string,filter:ConversationDateFilter,now=new Date(),options:Omit<ConversationListOptions,"cursor"|"limit">={}):string{
  const list=new URL(conversationListPath(filter,now,{...options,limit:40}),"http://relay.local");
  list.pathname=`/api/v1/conversations/${encodeURIComponent(id)}/summary`;
  list.searchParams.delete("limit");
  return`${list.pathname}${list.search}`;
}
