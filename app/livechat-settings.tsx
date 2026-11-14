"use client";
import {useCallback,useEffect,useState} from "react";
import {Copy,MessageCircle,Pencil,Plus,RefreshCw,Save,Trash2,X} from "lucide-react";
import {authorizedFetch} from "./auth-session";
import {confirmAction} from "./confirmation-ui";

const languages={"zh-CN":"简体中文","zh-TW":"繁體中文",en:"English",ja:"日本語",es:"Español",pt:"Português"};
type Language=keyof typeof languages;
type Channel={id:string;display_name:string;public_id:string;welcome_message:string;theme_color:string;position:"left"|"right";language:Language;allowed_origins:string[];enabled:boolean};
type Form={id?:string;displayName:string;welcomeMessage:string;themeColor:string;position:"left"|"right";language:Language;origins:string;enabled:boolean};
const blank=():Form=>({displayName:"",welcomeMessage:"",themeColor:"#146d73",position:"right",language:"en",origins:"",enabled:true});
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
  const formFor=(c:Channel):Form=>({id:c.id,displayName:c.display_name,welcomeMessage:c.welcome_message,themeColor:c.theme_color,position:c.position,language:c.language??"en",origins:c.allowed_origins.join("\n"),enabled:c.enabled});
  async function save(form:Form){
    if(busy)return;setBusy(true);setError("");
    try{const result=await authorizedFetch(`/api/v1/admin/livechat/channels${form.id?`/${form.id}`:""}`,token,{method:form.id?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify({displayName:form.displayName,welcomeMessage:form.welcomeMessage,themeColor:form.themeColor,position:form.position,language:form.language,allowedOrigins:form.origins.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),enabled:form.enabled})});if(result.token!==token)onToken(result.token);const body=await result.response.json();if(!result.response.ok)throw Error(body.error==="invalid_origin"?"域名必须为完整 HTTPS origin，不能包含路径或通配符":body.error||"保存失败");setEditing(null);await load();onAccountsChanged();onToast("LiveChat 渠道已保存");}catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setBusy(false);}
  }
  async function archive(c:Channel){
    if(!await confirmAction(`归档“${c.display_name}”？嵌入窗口和访客访问将停止，历史消息、客户资料和审计记录会保留。`,{title:"归档 LiveChat 渠道",confirmLabel:"确认归档",tone:"danger"}))return;
    setBusy(true);try{const result=await authorizedFetch(`/api/v1/admin/livechat/channels/${c.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok)throw Error("归档失败");await load();onAccountsChanged();onToast("渠道已归档，历史记录已保留");}catch(reason){setError(reason instanceof Error?reason.message:"归档失败");}finally{setBusy(false);}
  }
  async function copy(c:Channel){try{const base=(process.env.NEXT_PUBLIC_RELAY_API_URL||window.location.origin).replace(/\/$/,"");const src=new URL("/livechat/embed.js",base).href;await navigator.clipboard.writeText(`<script async src="${src}" data-channel="${c.public_id}"></script>`);onToast("嵌入代码已复制");}catch{setError("无法复制，请检查剪贴板权限");}}
  return <div className="livechat-settings"><header className="management-head"><h2>LiveChat 渠道</h2><div><button className="secondary-action" onClick={()=>void load()} disabled={busy} title="刷新"><RefreshCw size={14}/>刷新</button><button className="primary-action" onClick={()=>{setError("");setEditing(blank());}} disabled={busy}><Plus size={14}/>新增渠道</button></div></header>
    {error&&<p className="login-error" role="alert">{error}</p>}
    {loading?<p>正在读取渠道...</p>:channels.length?<div className="order-table-wrap"><table className="order-table"><thead><tr><th>渠道</th><th>允许的网站</th><th>状态</th><th>操作</th></tr></thead><tbody>{channels.map(c=><tr key={c.id}><td><MessageCircle size={14}/> {c.display_name}</td><td>{c.allowed_origins.map(origin=><div key={origin}>{origin}</div>)}</td><td>{c.enabled?"已启用":"已停用"}</td><td><span className="contact-row-actions"><button onClick={()=>void copy(c)} title="复制 JavaScript 嵌入代码"><Copy size={14}/>嵌入代码</button><button disabled={busy} onClick={()=>setEditing(formFor(c))}><Pencil size={14}/>编辑</button><label><input type="checkbox" checked={c.enabled} disabled={busy} onChange={()=>void save({...formFor(c),enabled:!c.enabled})}/>启用</label><button className="danger" disabled={busy} onClick={()=>void archive(c)}><Trash2 size={14}/>归档</button></span></td></tr>)}</tbody></table></div>:<p className="empty-note">尚未创建 LiveChat 渠道</p>}
    {editing&&<div className="modal-backdrop" role="presentation"><form className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="livechat-settings-title" onSubmit={event=>{event.preventDefault();void save(editing);}}><button type="button" className="login-close" disabled={busy} onClick={()=>setEditing(null)} aria-label="关闭"><X size={17}/></button><h2 id="livechat-settings-title">{editing.id?"编辑 LiveChat 渠道":"新增 LiveChat 渠道"}</h2><label>渠道名称<input autoFocus required maxLength={80} value={editing.displayName} onChange={e=>setEditing({...editing,displayName:e.target.value})}/></label><label>访客界面语言<select value={editing.language} onChange={e=>setEditing({...editing,language:e.target.value as Language})}>{Object.entries(languages).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>欢迎语<textarea maxLength={1000} value={editing.welcomeMessage} onChange={e=>setEditing({...editing,welcomeMessage:e.target.value})}/></label><label>主题色<input type="color" value={editing.themeColor} onChange={e=>setEditing({...editing,themeColor:e.target.value})}/></label><label>入口位置<select value={editing.position} onChange={e=>setEditing({...editing,position:e.target.value as Form["position"]})}><option value="right">右下角</option><option value="left">左下角</option></select></label><label>允许嵌入的域名<textarea required rows={4} value={editing.origins} placeholder={"https://example.com\nhttps://shop.example.com"} onChange={e=>setEditing({...editing,origins:e.target.value})}/></label><label><input type="checkbox" checked={editing.enabled} onChange={e=>setEditing({...editing,enabled:e.target.checked})}/>启用渠道</label>{error&&<span className="login-error">{error}</span>}<button type="submit" className="login-submit" disabled={busy}><Save size={14}/>{busy?"正在保存...":"保存渠道"}</button></form></div>}
  </div>;
}
