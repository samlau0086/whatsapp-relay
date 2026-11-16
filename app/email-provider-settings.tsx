"use client";
import {useCallback,useEffect,useState} from "react";
import {Check,Eye,EyeOff,Plus,RefreshCw,Send} from "lucide-react";
import {authorizedFetch} from "./auth-session";

type Provider={id:string;name:string;provider:"smtp"|"resend";enabled:boolean;isDefault:boolean;configured:boolean;fromName:string;fromEmail:string;replyTo:string;host:string;port:number;tls:"tls"|"starttls";username:string;secret:string};
type Props={token:string;accounts?:Array<{id:string;name:string;platform:string}>;onToken:(token:string)=>void;onToast:(message:string)=>void};
export function EmailProviderSettings({token,accounts=[],onToken,onToast}:Props){
  const [providers,setProviders]=useState<Provider[]>([]),[selected,setSelected]=useState(""),[bindings,setBindings]=useState<Record<string,string>>({}),[savedBindings,setSavedBindings]=useState<Record<string,string>>({});
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(""),[recipient,setRecipient]=useState(""),[visible,setVisible]=useState(false);
  const request=useCallback(async(path:string,init?:RequestInit)=>{
    const result=await authorizedFetch(path,token,init);
    if(result.token!==token)onToken(result.token);
    const body=await result.response.json();
    if(!result.response.ok)throw new Error(body.message||body.error||`HTTP ${result.response.status}`);
    return body;
  },[token,onToken]);
  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const body=await request("/api/v1/admin/email-providers");
      const next:Provider[]=body.data.map((item:Provider)=>({...item,secret:""}));
      const mapping=Object.fromEntries(body.bindings.map((item:{account_id:string;provider_id:string})=>[item.account_id,item.provider_id]));
      setProviders(next);setBindings(mapping);setSavedBindings(mapping);
      setSelected(value=>next.some(item=>item.id===value)?value:next[0]?.id||"");setError("");
    }catch(reason){setError(reason instanceof Error?reason.message:"邮件 Provider 加载失败");}finally{setLoading(false);}
  },[request]);
  useEffect(()=>{void load();},[load]);
  const current=providers.find(item=>item.id===selected);
  function change(patch:Partial<Provider>){setProviders(items=>items.map(item=>item.id===selected?{...item,...patch}:item));}
  function add(provider:Provider["provider"]){
    const item:Provider={id:crypto.randomUUID(),name:provider==="smtp"?"新增 SMTP":"新增 Resend",provider,enabled:true,isDefault:false,configured:false,fromName:"",fromEmail:"",replyTo:"",host:"",port:587,tls:"starttls",username:"",secret:""};
    setProviders(items=>[...items,item]);setSelected(item.id);setVisible(false);
  }
  async function save(event:React.FormEvent){
    event.preventDefault();if(!current)return;setBusy(true);setError("");
    try{
      await request(`/api/v1/admin/email-providers/${current.id}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({...current,secret:current.secret||undefined})});
      onToast("邮件 Provider 已保存");await load();
    }catch(reason){setError(reason instanceof Error?reason.message:"保存失败");}finally{setBusy(false);}
  }
  async function test(){
    if(!current)return;setBusy(true);setError("");
    try{await request(`/api/v1/admin/email-providers/${current.id}/test`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({recipientEmail:recipient})});onToast("测试邮件已被 Provider 接受");}
    catch(reason){setError(reason instanceof Error?reason.message:"测试失败");}finally{setBusy(false);}
  }
  async function bind(accountId:string){
    setBusy(true);setError("");const providerId=bindings[accountId]||null;
    try{await request(`/api/v1/admin/email-provider-bindings/${accountId}`,{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({providerId})});setSavedBindings(items=>({...items,[accountId]:providerId||""}));onToast("渠道邮件 Provider 已保存");}
    catch(reason){setError(reason instanceof Error?reason.message:"渠道保存失败");}finally{setBusy(false);}
  }
  return <div className="settings-provider-section email-instance-settings" aria-busy={loading||busy}>
    <div className="settings-section-head"><h2>邮件发送 Provider</h2><div className="email-instance-toolbar"><button className="secondary-action" disabled={loading||busy} onClick={()=>add("smtp")}><Plus size={15}/>新增 SMTP</button><button className="secondary-action" disabled={loading||busy} onClick={()=>add("resend")}><Plus size={15}/>新增 Resend</button><button className="secondary-action" disabled={loading||busy} onClick={()=>void load()}><RefreshCw size={15}/>刷新</button></div></div>
    {error&&<p className="login-error" role="alert">{error}</p>}
    {loading?<p role="status">正在读取邮件 Provider…</p>:<>
      <div className="provider-settings-layout"><nav className="provider-list" aria-label="邮件 Provider">{providers.map(item=><button key={item.id} disabled={busy} className={selected===item.id?"active":""} onClick={()=>{setSelected(item.id);setVisible(false);}}><span><b>{item.name}</b><small>{item.provider==="smtp"?"SMTP":"Resend"} · {item.fromEmail||"未设置发件邮箱"}</small></span><em className={item.enabled?"enabled":""}>{!item.configured?"待保存":item.isDefault?"默认":item.enabled?"已启用":"已停用"}</em></button>)}</nav>
      {current&&<form className="provider-form" onSubmit={save}><fieldset disabled={busy} className="email-instance-fieldset"><header><h2>{current.provider==="smtp"?"SMTP":"Resend API"}</h2><label className="provider-toggle"><input type="checkbox" checked={current.enabled} onChange={event=>change({enabled:event.target.checked,...(!event.target.checked?{isDefault:false}:{})})}/><span>启用</span></label></header>
        <label>配置名称<input required maxLength={120} value={current.name} onChange={event=>change({name:event.target.value})}/></label>
        <label className="provider-toggle"><input type="checkbox" disabled={!current.enabled} checked={current.isDefault} onChange={event=>change({isDefault:event.target.checked})}/><span>工作区默认 Provider</span></label>
        <div className="provider-form-grid"><label>发件人名称<input required maxLength={120} value={current.fromName} onChange={event=>change({fromName:event.target.value})}/></label><label>发件人邮箱<input required type="email" maxLength={254} value={current.fromEmail} onChange={event=>change({fromEmail:event.target.value})}/></label></div>
        <label>Reply-To<input type="email" value={current.replyTo} onChange={event=>change({replyTo:event.target.value})}/></label>
        {current.provider==="smtp"&&<><div className="provider-form-grid"><label>SMTP Host<input required value={current.host} onChange={event=>change({host:event.target.value})}/></label><label>端口<input required type="number" min={1} max={65535} value={current.port} onChange={event=>change({port:Number(event.target.value)})}/></label></div><div className="provider-form-grid"><label>TLS 模式<select value={current.tls} onChange={event=>change({tls:event.target.value as Provider["tls"]})}><option value="starttls">STARTTLS</option><option value="tls">直接 TLS</option></select></label><label>用户名<input value={current.username} onChange={event=>change({username:event.target.value})}/></label></div></>}
        <label>{current.provider==="smtp"?"SMTP 密码 / 应用密码":"Resend API Key"}<span className="email-instance-secret"><input type={visible?"text":"password"} autoComplete="new-password" required={current.enabled&&!current.configured} value={current.secret} placeholder={current.configured?"已配置；留空保持不变":"请输入密钥"} onChange={event=>change({secret:event.target.value})}/><button type="button" className="secondary-action" title={visible?"隐藏密钥":"显示密钥"} aria-label={visible?"隐藏密钥":"显示密钥"} onClick={()=>setVisible(value=>!value)}>{visible?<EyeOff size={16}/>:<Eye size={16}/>}</button></span></label>
        <div className="email-instance-toolbar"><button type="submit" className="primary-action"><Check size={15}/>{busy?"正在处理…":"保存配置"}</button><input aria-label="测试收件邮箱" type="email" value={recipient} onChange={event=>setRecipient(event.target.value)} placeholder="测试收件邮箱"/><button type="button" className="secondary-action" disabled={!current.configured||!recipient.trim()} onClick={()=>void test()}><Send size={15}/>发送测试邮件</button></div>
      </fieldset></form>}
      </div>
      <section className="email-channel-bindings"><h2>渠道邮件 Provider</h2>{accounts.map(account=><div className="email-channel-binding" key={account.id}><label htmlFor={`email-provider-${account.id}`}><b>{account.name}</b><small>{account.platform}</small></label><select id={`email-provider-${account.id}`} disabled={busy} value={bindings[account.id]||""} onChange={event=>setBindings(items=>({...items,[account.id]:event.target.value}))}><option value="">工作区默认</option>{providers.filter(item=>item.configured||item.id===bindings[account.id]).map(item=><option key={item.id} value={item.id} disabled={!item.enabled||!item.configured}>{item.name} ({item.provider}){!item.enabled?" · 已停用":""}</option>)}</select><button className="secondary-action" disabled={busy||(bindings[account.id]||"")===(savedBindings[account.id]||"")} onClick={()=>void bind(account.id)}><Check size={15}/>保存</button></div>)}</section>
    </>}
  </div>;
}
