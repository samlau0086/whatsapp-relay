export type ConversationDateFilter="all"|"today"|"yesterday"|"last7"|"last15"|"unreplied";
export type ConversationListFilter="all"|"mine"|"unassigned"|"favorite"|"closed"|"archived"|"reminders";
export type ConversationListOptions={filter?:ConversationListFilter;accountId?:string;q?:string;cursor?:string;limit?:number};

export const CONVERSATION_DATE_FILTERS:Array<{value:ConversationDateFilter;label:string}>=[
  {value:"all",label:"全部"},
  {value:"today",label:"今天"},
  {value:"yesterday",label:"昨天"},
  {value:"last7",label:"最近7天"},
  {value:"last15",label:"最近15天"},
  {value:"unreplied",label:"未回复"},
];

export function conversationDateRange(filter:ConversationDateFilter,now=new Date()):{from?:string;before?:string}{
  if(filter==="all"||filter==="unreplied")return{};
  const today=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const tomorrow=new Date(today);tomorrow.setDate(today.getDate()+1);
  const from=new Date(today);
  if(filter==="yesterday")from.setDate(today.getDate()-1);
  if(filter==="last7")from.setDate(today.getDate()-6);
  if(filter==="last15")from.setDate(today.getDate()-14);
  return{from:from.toISOString(),before:(filter==="yesterday"?today:tomorrow).toISOString()};
}

export function conversationListPath(filter:ConversationDateFilter,now=new Date(),options:ConversationListOptions={}):string{
  const params=new URLSearchParams({limit:String(options.limit??40)});
  if(options.filter)params.set("filter",options.filter);
  if(options.accountId)params.set("accountId",options.accountId);
  if(options.q?.trim())params.set("q",options.q.trim());
  if(options.cursor)params.set("cursor",options.cursor);
  if(filter==="unreplied")params.set("unreplied","true");
  const range=conversationDateRange(filter,now);
  if(range.from)params.set("lastMessageFrom",range.from);
  if(range.before)params.set("lastMessageBefore",range.before);
  return`/api/v1/conversations?${params.toString()}`;
}

export function conversationCountsPath(filter:ConversationDateFilter,now=new Date(),accountId=""):string{
  const params=new URLSearchParams();
  if(accountId)params.set("accountId",accountId);
  if(filter==="unreplied")params.set("unreplied","true");
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
