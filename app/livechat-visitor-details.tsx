export type LivechatVisitorInfo={
  firstIp:string|null;lastIp:string|null;embedOrigin:string;
  context:{browserLanguage?:string;timeZone?:string;pageUrl?:string;userAgent?:string};
  createdAt:string;lastSeenAt:string;
};

export function LivechatVisitorDetails({visitor,companyName,presence}:{visitor?:LivechatVisitorInfo|null;companyName?:string;presence?:import("./livechat-presence").LivechatPresence}){
  if(!visitor)return null;
  const fields=[
    ["公司",companyName],["首次 IP",visitor.firstIp],["最近 IP",visitor.lastIp],
    ["浏览器语言",visitor.context.browserLanguage],["浏览器时区",visitor.context.timeZone],
    ["网站来源",visitor.embedOrigin],["当前浏览页面",presence?.status==="online"?presence.pageUrl||"未上报":presence?.status==="away"?"访客已离开当前标签页":presence?.status==="offline"?"访客已离线":"状态未知"],["最近消息页面",visitor.context.pageUrl],
    ["浏览器",visitor.context.userAgent],
    ["首次接入",visitor.createdAt?new Date(visitor.createdAt).toLocaleString("zh-CN"):null],
    ["最近消息",visitor.lastSeenAt?new Date(visitor.lastSeenAt).toLocaleString("zh-CN"):null],
  ];
  return <section className="detail-section crm-section" aria-label="网站访客信息">
    <h3>网站访客信息</h3>
    <dl style={{margin:0,display:"grid",gridTemplateColumns:"86px minmax(0,1fr)",gap:"8px",fontSize:12}}>
      {fields.filter(([,value])=>value).map(([label,value])=><div key={label} style={{display:"contents"}}><dt style={{color:"#64706c"}}>{label}</dt><dd style={{margin:0,overflowWrap:"anywhere"}}>{value}</dd></div>)}
    </dl>
  </section>;
}
