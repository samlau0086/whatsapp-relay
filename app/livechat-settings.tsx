"use client";
import {useCallback,useEffect,useState} from "react";
import {ArrowDown,ArrowUp,Copy,MessageCircle,Pencil,Plus,RefreshCw,Save,Trash2,X} from "lucide-react";
import {authorizedFetch} from "./auth-session";
import {confirmAction} from "./confirmation-ui";
import {GoogleAdsSettings} from "./google-ads-settings";
import {Button,IconButton} from "./ui/button";
import {FormField} from "./ui/form-field";

const languages={"zh-CN":"简体中文","zh-TW":"繁體中文",en:"English",ja:"日本語",es:"Español",pt:"Português"};
type Language=keyof typeof languages;
type Channel={id:string;display_name:string;public_id:string;welcome_message:string;starter_messages?:string[];icon_url?:string;theme_color:string;position:"left"|"right";language:Language;allowed_origins:string[];enabled:boolean;ga4_measurement_id?:string|null;ga4ApiSecretConfigured?:boolean};
type Form={id?:string;displayName:string;welcomeMessage:string;starterMessages:string[];iconUrl:string;themeColor:string;position:"left"|"right";language:Language;origins:string;enabled:boolean;ga4MeasurementId:string;ga4ApiSecret:string;ga4ApiSecretConfigured?:boolean};
const blank=():Form=>({displayName:"",iconUrl:"",welcomeMessage:"",starterMessages:[],themeColor:"#146d73",position:"right",language:"en",origins:"",enabled:true,ga4MeasurementId:"",ga4ApiSecret:""});
export function LivechatSettingsPanel({token,onToken,onToast,onAccountsChanged}:{token:string;onToken:(value:string)=>void;onToast:(value:string)=>void;onAccountsChanged:()=>void}){
  const [channels,setChannels]=useState<Channel[]>([]),[editing,setEditing]=useState<Form|null>(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const fetchChannels=useCallback(async():Promise<Channel[]>=>{
    const result=await authorizedFetch("/api/v1/admin/livechat/channels",token);if(result.token!==token)onToken(result.token);const body=await result.response.json();if(!result.response.ok)throw Error(body.error||"读取渠道失败");return body.data;
  },[token,onToken]);
  const load=useCallback(async()=>{
    try{setChannels(await fetchChannels());setError("");}catch(reason){setError(reason instanceof Error?reason.message:"读取渠道失败");}finally{setLoading(false);}
  },[fetchChannels]);
  useEffect(()=>{
    let active=true;
    void fetchChannels().then(data=>{if(active){setChannels(data);setError("");}},reason=>{if(active)setError(reason instanceof Error?reason.message:"读取渠道失败");}).finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[fetchChannels]);
  const formFor=(c:Channel):Form=>({id:c.id,displayName:c.display_name,iconUrl:c.icon_url??"",welcomeMessage:c.welcome_message,starterMessages:c.starter_messages??[],themeColor:c.theme_color,position:c.position,language:c.language??"en",origins:c.allowed_origins.join("\n"),enabled:c.enabled,ga4MeasurementId:c.ga4_measurement_id??"",ga4ApiSecret:"",ga4ApiSecretConfigured:c.ga4ApiSecretConfigured});
  function moveStarter(index:number,direction:number){if(!editing)return;const items=[...editing.starterMessages];[items[index],items[index+direction]]=[items[index+direction],items[index]];setEditing({...editing,starterMessages:items});}
  async function save(form:Form){
    if(busy)return;setBusy(true);setError("");
    try{const result=await authorizedFetch(`/api/v1/admin/livechat/channels${form.id?`/${form.id}`:""}`,token,{method:form.id?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify({displayName:form.displayName,iconUrl:form.iconUrl,welcomeMessage:form.welcomeMessage,starterMessages:form.starterMessages.map(value=>value.trim()),themeColor:form.themeColor,position:form.position,language:form.language,allowedOrigins:form.origins.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),enabled:form.enabled,...(editing?{ga4MeasurementId:form.ga4MeasurementId,...(form.ga4ApiSecret?{ga4ApiSecret:form.ga4ApiSecret}:{})}:{})})});if(result.token!==token)onToken(result.token);const body=await result.response.json();if(!result.response.ok)throw Error(body.error==="invalid_origin"?"域名必须为完整 HTTPS origin，不能包含路径或通配符":body.message||body.error||"保存失败");setEditing(null);await load();onAccountsChanged();onToast("LiveChat 渠道已保存");}catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setBusy(false);}
  }
  async function archive(c:Channel){
    if(!await confirmAction(`归档“${c.display_name}”？嵌入窗口和访客访问将停止，历史消息、客户资料和审计记录会保留。`,{title:"归档 LiveChat 渠道",confirmLabel:"确认归档",tone:"danger"}))return;
    setBusy(true);try{const result=await authorizedFetch(`/api/v1/admin/livechat/channels/${c.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok)throw Error("归档失败");await load();onAccountsChanged();onToast("渠道已归档，历史记录已保留");}catch(reason){setError(reason instanceof Error?reason.message:"归档失败");}finally{setBusy(false);}
  }
  async function copy(c:Channel){try{const base=(process.env.NEXT_PUBLIC_RELAY_API_URL||window.location.origin).replace(/\/$/,"");const src=new URL("/livechat/embed.js",base).href;await navigator.clipboard.writeText(`<script async src="${src}" data-channel="${c.public_id}"></script>`);onToast("嵌入代码已复制");}catch{setError("无法复制，请检查剪贴板权限");}}
  return <div className="livechat-settings"><header className="management-head"><h2>LiveChat 渠道</h2><div><button className="secondary-action" onClick={()=>void load()} disabled={busy} title="刷新"><RefreshCw size={14}/>刷新</button><button className="primary-action" onClick={()=>{setError("");setEditing(blank());}} disabled={busy}><Plus size={14}/>新增渠道</button></div></header>
    {error&&!editing&&<p className="login-error" role="alert">{error}</p>}
    {loading?<p>正在读取渠道...</p>:channels.length?<div className="order-table-wrap"><table className="order-table"><thead><tr><th>渠道</th><th>允许的网站</th><th>状态</th><th>操作</th></tr></thead><tbody>{channels.map(c=><tr key={c.id}><td><MessageCircle size={14}/> {c.display_name}</td><td>{c.allowed_origins.map(origin=><div key={origin}>{origin}</div>)}</td><td>{c.enabled?"已启用":"已停用"}</td><td><span className="contact-row-actions"><button onClick={()=>void copy(c)} title="复制 JavaScript 嵌入代码"><Copy size={14}/>嵌入代码</button><button disabled={busy} onClick={()=>setEditing(formFor(c))}><Pencil size={14}/>编辑</button><label><input type="checkbox" checked={c.enabled} disabled={busy} onChange={()=>void save({...formFor(c),enabled:!c.enabled})}/>启用</label><button className="danger" disabled={busy} onClick={()=>void archive(c)}><Trash2 size={14}/>归档</button></span></td></tr>)}</tbody></table></div>:<p className="empty-note">尚未创建 LiveChat 渠道</p>}
    <GoogleAdsSettings token={token} onToken={onToken}/>
    {editing&&<div className="modal-backdrop livechat-editor-backdrop" role="presentation">
      <form className="livechat-editor" role="dialog" aria-modal="true" aria-labelledby="livechat-settings-title" aria-busy={busy} onSubmit={event=>{event.preventDefault();void save(editing);}} onKeyDown={event=>{
        if(event.key==="Escape"){event.preventDefault();if(!busy)setEditing(null);}
        if(event.key!=="Tab")return;
        const controls=Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)'));
        const first=controls[0],last=controls[controls.length-1];
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }}>
        <header className="livechat-editor-header">
          <h2 id="livechat-settings-title">{editing.id?"编辑 LiveChat 渠道":"新增 LiveChat 渠道"}</h2>
          <button type="button" className="livechat-editor-close" disabled={busy} onClick={()=>setEditing(null)} aria-label="关闭" title="关闭"><X size={18}/></button>
        </header>
        <div className="livechat-editor-body">
          <fieldset disabled={busy} className="livechat-editor-fields">
            <label className="livechat-editor-wide" htmlFor="livechat-name">渠道名称<input id="livechat-name" autoFocus required maxLength={80} placeholder="渠道名称" value={editing.displayName} onChange={e=>setEditing({...editing,displayName:e.target.value})}/></label>
            <label className="livechat-editor-wide" htmlFor="livechat-icon">自定义图标（HTTPS 图片地址）<input id="livechat-icon" type="url" maxLength={2048} pattern="https://.*" placeholder="https://example.com/logo.png" value={editing.iconUrl} onChange={e=>setEditing({...editing,iconUrl:e.target.value})}/></label>
            <label htmlFor="livechat-language">访客界面语言<select id="livechat-language" aria-label="访客界面语言" value={editing.language} onChange={e=>setEditing({...editing,language:e.target.value as Language})}>{Object.entries(languages).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
            <label htmlFor="livechat-position">入口位置<select id="livechat-position" aria-label="入口位置" value={editing.position} onChange={e=>setEditing({...editing,position:e.target.value as Form["position"]})}><option value="right">右下角</option><option value="left">左下角</option></select></label>
            <label className="livechat-editor-wide" htmlFor="livechat-welcome">欢迎语<textarea id="livechat-welcome" rows={3} maxLength={1000} value={editing.welcomeMessage} onChange={e=>setEditing({...editing,welcomeMessage:e.target.value})}/></label>
            <section className="rd-livechat-starter-editor livechat-editor-wide" aria-label="快捷引导消息">
              <header><h3>快捷引导消息</h3><Button icon={Plus} size="compact" disabled={busy||editing.starterMessages.length>=50} onClick={()=>setEditing({...editing,starterMessages:[...editing.starterMessages,""]})}>添加问题</Button></header>
              {editing.starterMessages.map((text,index)=><div className="rd-livechat-starter-row" key={index}>
                <FormField label={`引导问题 ${index+1}`} required>{props=><textarea {...props} rows={2} maxLength={500} value={text} onChange={e=>setEditing({...editing,starterMessages:editing.starterMessages.map((value,i)=>i===index?e.target.value:value)})}/>}</FormField>
                <div className="rd-livechat-starter-actions"><IconButton icon={ArrowUp} label={`上移问题 ${index+1}`} disabled={busy||index===0} onClick={()=>moveStarter(index,-1)}/><IconButton icon={ArrowDown} label={`下移问题 ${index+1}`} disabled={busy||index===editing.starterMessages.length-1} onClick={()=>moveStarter(index,1)}/><IconButton icon={Trash2} variant="ghost" label={`删除问题 ${index+1}`} disabled={busy} onClick={()=>setEditing({...editing,starterMessages:editing.starterMessages.filter((_,i)=>i!==index)})}/></div>
              </div>)}
            </section>
            <label className="livechat-editor-wide" htmlFor="livechat-color">主题色<div className="livechat-editor-color"><input id="livechat-color" aria-label="主题色" type="color" value={editing.themeColor} onChange={e=>setEditing({...editing,themeColor:e.target.value})}/><output htmlFor="livechat-color">{editing.themeColor.toUpperCase()}</output></div></label>
            <label className="livechat-editor-wide" htmlFor="livechat-origins">允许嵌入的域名<textarea id="livechat-origins" required rows={3} value={editing.origins} placeholder={"https://example.com\nhttps://shop.example.com"} onChange={e=>setEditing({...editing,origins:e.target.value})}/></label>
            <label className="livechat-editor-wide" htmlFor="livechat-ga4-id">GA4 Measurement ID（可选）<input id="livechat-ga4-id" pattern="G-[A-Z0-9]+" maxLength={40} placeholder="G-XXXXXXXXXX" value={editing.ga4MeasurementId} onChange={e=>setEditing({...editing,ga4MeasurementId:e.target.value.trim().toUpperCase()})}/></label>
            <label className="livechat-editor-wide" htmlFor="livechat-ga4-secret">GA4 API secret（仅后台回传需要）<input id="livechat-ga4-secret" type="password" autoComplete="new-password" pattern="[A-Za-z0-9_\-]+" maxLength={256} placeholder={editing.ga4ApiSecretConfigured?"已设置，保持 ID 不变且留空则保留":"不回显已保存的密钥"} value={editing.ga4ApiSecret} onChange={e=>setEditing({...editing,ga4ApiSecret:e.target.value.trim()})}/></label>
            <label className="livechat-editor-enabled livechat-editor-wide"><input type="checkbox" checked={editing.enabled} onChange={e=>setEditing({...editing,enabled:e.target.checked})}/>启用渠道</label>
          </fieldset>
        </div>
        <footer className="livechat-editor-footer">
          {error&&<p className="livechat-editor-error" role="alert">{error}</p>}
          <div><button type="button" className="secondary-action" disabled={busy} onClick={()=>setEditing(null)}>取消</button><button type="submit" className="primary-action" disabled={busy}><Save size={16}/>{busy?"正在保存...":"保存渠道"}</button></div>
        </footer>
      </form>
    </div>}
  </div>;
}
