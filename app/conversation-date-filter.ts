export type ConversationDateFilter="all"|"today"|"yesterday"|"last7"|"last15"|"unreplied";

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

export function conversationListPath(filter:ConversationDateFilter,now=new Date()):string{
  const params=new URLSearchParams({limit:"100"});
  if(filter==="unreplied")params.set("unreplied","true");
  const range=conversationDateRange(filter,now);
  if(range.from)params.set("lastMessageFrom",range.from);
  if(range.before)params.set("lastMessageBefore",range.before);
  return`/api/v1/conversations?${params.toString()}`;
}
