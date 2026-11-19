export type TimelineRecipient={id:string;contactId:string;accountId?:string;conversionMode?:string;name:string;latestIncomingAt:string|null;latestIncomingId:string|null};

export function defaultTimelineRecipient(members:TimelineRecipient[],rootId:string):string{
  const latest=members.filter(item=>item.latestIncomingAt).sort((a,b)=>
    (b.latestIncomingAt??"").localeCompare(a.latestIncomingAt??"")||(b.latestIncomingId??"").localeCompare(a.latestIncomingId??""));
  return latest[0]?.id??(members.some(item=>item.id===rootId)?rootId:members[0]?.id??"");
}

export function TimelineRecipientPicker({members,value,disabled,onChange}:{members:TimelineRecipient[];value:string;disabled:boolean;onChange:(id:string)=>void}){
  return <label className="timeline-recipient">回复给 <select aria-label="回复接收人" value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}>
    {!members.length&&<option value="">正在加载…</option>}
    {members.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
  </select></label>;
}
