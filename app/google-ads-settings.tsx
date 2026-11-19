"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {Link,RefreshCw,Save,Unplug} from "lucide-react";
import {authorizedFetch} from "./auth-session";
import {confirmAction} from "./confirmation-ui";
import {AsyncState,Button,FormField} from "./ui";

type Settings={id:string;display_name:string;enabled:boolean;customerId:string;loginCustomerId:string;qualifyLeadAction:string;closeConvertLeadAction:string;purchaseAction:string;revision:number};
type Data={connected:boolean;oauthConfigured:boolean;data:Settings[]};
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
    <label><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={e=>setDraft({...draft,enabled:e.target.checked})}/>启用 Ads 回传</label>
    <div className="rd-ads-fields">{fields.map(([key,label])=><FormField key={key} label={label}>{p=><input {...p} inputMode="numeric" pattern={key==='customerId'||key==='loginCustomerId'?'[0-9]{10}':'[0-9]{1,30}'} required={draft.enabled&&key==='customerId'} value={draft[key]} disabled={busy} onChange={e=>setDraft({...draft,[key]:e.target.value})}/>}</FormField>)}</div>
    <Button icon={Save} type="submit" loading={busy}>保存 Ads 配置</Button>{error&&<p role="alert">{error}</p>}{saved&&<p role="status">已保存</p>}
  </form>;
}
