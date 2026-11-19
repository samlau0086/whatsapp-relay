"use client";
import {useCallback,useEffect,useId,useRef,useState} from "react";
import {CircleHelp,Link,RefreshCw,Save,Unplug} from "lucide-react";
import {authorizedFetch} from "./auth-session";
import {confirmAction} from "./confirmation-ui";
import {AsyncState,Button,IconButton} from "./ui";

type Settings={id:string;display_name:string;enabled:boolean;customerId:string;loginCustomerId:string;qualifyLeadAction:string;closeConvertLeadAction:string;purchaseAction:string;revision:number};
type Data={connected:boolean;oauthConfigured:boolean;data:Settings[]};
const actionSource='获取：Google Ads → 目标 → 转化 → 摘要，打开对应动作详情，复制地址栏 ctId= 后的数字。没有动作时先创建离线／点击导入动作（UPLOAD_CLICKS），不是网页标签或 GA4 导入。没有 ctId 时请通过 Google Ads API 查询 conversion_action.id，不要猜测其他参数。';
const fieldHelp={
  enabled:['控制当前渠道的 Ads 回传，不影响聊天或 GA4。只有后台明确标记转化才会回传；启用后不补历史。','操作：先完成 OAuth 授权，核对账号及动作 ID，再勾选并保存。配置变更会停止未发送的旧版本事件。'],
  customerId:['接收转化且拥有下方动作的 Ads 账号 ID，不是 OAuth Client ID。填写 10 位数字，不带横线。','获取：登录 Google Ads，切换到目标账号，点击右上角头像／账号菜单查看客户 ID，例如 123-456-7890 填 1234567890。跨账号转化跟踪时请核对动作所属账号。'],
  loginCustomerId:['通过管理账号（MCC）访问目标账号时填写；直接授权目标账号通常留空。必须已有访问权限，填写 ID 不会授予权限。','获取：在 Google Ads 切换到管理账号，点击左上角账号名称旁的下拉箭头，查看该管理账号自己的客户 ID。填 10 位数字，不带横线，不要重复填子账号 ID。'],
  qualifyLeadAction:['对应 qualify_lead：坐席确认客户有真实需求、符合目标客户条件后，人工标记合格线索时回传。',actionSource],
  closeConvertLeadAction:['对应 close_convert_lead：人工确认线索成交时回传。与购买事件独立，不会自动互相触发。',actionSource],
  purchaseAction:['对应 purchase：人工标记购买并选择同客户、同渠道的已付款非沙盒订单后，回传商品小计与订单币种。',actionSource],
} as const;

function AdsHelp({label,field}:{label:string;field:keyof typeof fieldHelp}){
  const id=useId(),anchor=useRef<HTMLSpanElement>(null),panel=useRef<HTMLDivElement>(null),timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const [open,setOpen]=useState(false);
  function cancel(){clearTimeout(timer.current);}
  function show(){cancel();panel.current?.showPopover();}
  function leave(){cancel();timer.current=setTimeout(()=>{if(!anchor.current?.querySelector('button:focus-visible'))panel.current?.hidePopover();},180);}
  useEffect(()=>()=>clearTimeout(timer.current),[]);
  useEffect(()=>{
    if(!open)return;
    const element=panel.current!,trigger=anchor.current!;
    function position(){
      const rect=trigger.getBoundingClientRect(),viewport=window.visualViewport;
      const width=viewport?.width??innerWidth,height=viewport?.height??innerHeight,left=viewport?.offsetLeft??0,top=viewport?.offsetTop??0;
      const below=Math.max(0,top+height-rect.bottom-16),above=Math.max(0,rect.top-top-16);
      element.style.maxWidth=`${Math.max(0,width-24)}px`;element.style.maxHeight=`${Math.max(below,above)}px`;
      element.style.left=`${Math.max(left+12,Math.min(rect.left,left+width-element.offsetWidth-12))}px`;
      element.style.top=`${below>=element.offsetHeight||below>=above?rect.bottom+8:Math.max(top+8,rect.top-element.offsetHeight-8)}px`;
    }
    position();const observer=new ResizeObserver(position);observer.observe(trigger);observer.observe(element);
    window.addEventListener('scroll',position,true);window.addEventListener('resize',position);
    window.visualViewport?.addEventListener('resize',position);window.visualViewport?.addEventListener('scroll',position);
    return()=>{observer.disconnect();window.removeEventListener('scroll',position,true);window.removeEventListener('resize',position);window.visualViewport?.removeEventListener('resize',position);window.visualViewport?.removeEventListener('scroll',position);};
  },[open]);
  return <span ref={anchor} className="rd-ads-help" onPointerEnter={e=>{if(e.pointerType!=='touch')show();}} onPointerLeave={leave} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget)){cancel();panel.current?.hidePopover();}}}>
    <IconButton icon={CircleHelp} label={`${label}说明与获取方式`} variant="ghost" className="rd-ads-help-trigger" aria-expanded={open} aria-controls={id} aria-describedby={open?id:undefined} onFocus={show} onClick={show}/>
    <div ref={panel} id={id} popover="auto" role="tooltip" aria-label={`${label}说明与获取方式`} className="rd-popover rd-ads-help-panel" onToggle={e=>setOpen(e.newState==='open')} onPointerEnter={cancel} onPointerLeave={leave}>
      <strong>{label}</strong>{fieldHelp[field].map(text=><p key={text}>{text}</p>)}
      {field.endsWith('Action')&&<p>仅填数字 ID，不是动作名称、AW-…、Conversion label 或整个 URL；三个字段分别使用各自动作的 ID，留空则不回传该类事件。</p>}
    </div>
  </span>;
}

function AdsField({field,label,value,required,disabled,onChange}:{field:Exclude<keyof typeof fieldHelp,'enabled'>;label:string;value:string;required:boolean;disabled:boolean;onChange:(value:string)=>void}){
  const id=useId();
  return <div className="rd-field"><div className="rd-ads-label"><label htmlFor={id}>{label}</label><AdsHelp label={label} field={field}/></div>
    <input id={id} inputMode="numeric" pattern={field==='customerId'||field==='loginCustomerId'?'[0-9]{10}':'[0-9]{1,30}'} required={required} value={value} disabled={disabled} onChange={e=>onChange(e.target.value)}/>
  </div>;
}
export function GoogleAdsSettings({token,onToken}:{token:string;onToken:(value:string)=>void}){
  const [data,setData]=useState<Data>(),[error,setError]=useState(""),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const locked=useRef(false);
  const request=useCallback(async(path:string,options?:RequestInit)=>{
    const r=await authorizedFetch('/api/v1/admin/google-ads'+path,token,options);if(r.token!==token)onToken(r.token);
    const body=await r.response.json();if(!r.response.ok)throw Error(body.message??body.error??'请求失败');return body;
  },[token,onToken]);
  useEffect(()=>{let active=true;void request('').then(body=>{if(active){setData(body);setError('');}},e=>{if(active)setError(e.message);});return()=>{active=false;};},[request,revision]);
  async function connection(disconnect=false){
    if(locked.current)return;
    if(disconnect&&!await confirmAction('断开 Google Ads 授权？未发送事件将停止回传。',{title:'断开 Google Ads',confirmLabel:'断开',tone:'danger'}))return;
    const popup=disconnect?null:window.open('about:blank','_blank');
    if(!disconnect&&!popup){setError('浏览器阻止了授权窗口，请允许弹窗后重试');return;}
    if(popup)popup.opener=null;
    locked.current=true;setBusy(true);setError('');
    try{const body=await request(disconnect?'/connection':'/authorize',{method:disconnect?'DELETE':'POST'});if(body.url&&popup)popup.location.replace(body.url);else{popup?.close();setRevision(v=>v+1);}}
    catch(e){popup?.close();setError(e instanceof Error?e.message:'授权失败');}finally{locked.current=false;setBusy(false);}
  }
  return <section className="rd-ads-settings" aria-label="Google Ads 设置"><h2>Google Ads</h2>
    <AsyncState status={error?(data?'partial':'error'):data?'ready':'loading'} message={error||undefined} onRetry={()=>setRevision(v=>v+1)}>
      {data&&<><p>{data.connected?'已授权':'未授权'} · {data.oauthConfigured?'OAuth 已配置':'服务器尚未配置 OAuth'}</p><div className="rd-ads-actions">
        <Button icon={Link} disabled={busy||!data.oauthConfigured} onClick={()=>void connection()}>授权 Google Ads</Button>
        <Button icon={Unplug} variant="danger" disabled={busy||!data.connected} onClick={()=>void connection(true)}>断开授权</Button>
        <Button icon={RefreshCw} disabled={busy} onClick={()=>setRevision(v=>v+1)}>刷新授权状态</Button></div>
        {data.data.map(s=><ChannelSettings key={s.id+':'+s.revision} settings={s} request={request} onSaved={()=>setRevision(v=>v+1)}/>)}
      </>}
    </AsyncState>
  </section>;
}
function ChannelSettings({settings,request,onSaved}:{settings:Settings;request:(path:string,options?:RequestInit)=>Promise<unknown>;onSaved:()=>void}){
  const [draft,setDraft]=useState(settings),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false);const lock=useRef(false);
  const fields=[['customerId','Google Ads 客户 ID'],['loginCustomerId','管理账号 ID（可选）'],['qualifyLeadAction','合格线索转化动作 ID'],['closeConvertLeadAction','成交线索转化动作 ID'],['purchaseAction','购买转化动作 ID']] as const;
  async function save(){if(lock.current)return;lock.current=true;setBusy(true);setError('');setSaved(false);try{
    const {id,display_name,...payload}=draft;void display_name;
    await request('/channels/'+id,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});setSaved(true);onSaved();
  }catch(e){setError(e instanceof Error?e.message:'保存失败');}finally{lock.current=false;setBusy(false);}}
  return <form className="rd-ads-channel" onSubmit={e=>{e.preventDefault();void save();}}><h3>{settings.display_name}</h3>
    <div className="rd-ads-label"><label><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>启用 Ads 回传</label><AdsHelp label="启用 Ads 回传" field="enabled"/></div>
    <div className="rd-ads-fields">{fields.map(([key,label])=><AdsField key={key} field={key} label={label} required={draft.enabled&&key==='customerId'} value={draft[key]} disabled={busy} onChange={value=>setDraft({...draft,[key]:value})}/>)}</div>
    <Button icon={Save} type="submit" loading={busy}>保存 Ads 配置</Button>{error&&<p role="alert">{error}</p>}{saved&&<p role="status">已保存</p>}
  </form>;
}
