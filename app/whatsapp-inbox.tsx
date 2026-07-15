"use client";

import {
  Archive, Bookmark, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, FileText,
  Inbox, Info, Menu, MessageCircle, Mic, Paperclip, Phone,
  RefreshCw, Search, Send, Settings, ShieldCheck, Smile, Sparkles, Star, UserPlus,
  Users, Wifi, WifiOff, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

const API_URL = (process.env.NEXT_PUBLIC_RELAY_API_URL ?? "").replace(/\/$/, "");
const COLORS = ["#6b4f3a", "#305f72", "#9b5f72", "#477a62", "#705b86"];
let refreshPromise:Promise<string>|null=null;

type Account = { id:string; name:string; phone:string; status:string; reason:string; lastEvent?:string };
type Conversation = {
  id:string; name:string; initials:string; color:string; account:string; accountId:string; phone:string;
  preview:string; time:string; unread:number; accountStatus:string; assignedUserId:string|null;
  favorite:boolean; conversationStatus:string;
};
type ChatMessage = {
  id:string; direction:"in"|"out"; kind:string; text:string; time:string;
  status?:"received"|"queued"|"dispatching"|"sent"|"delivered"|"read"|"failed"|"uncertain";
  attachment?:{name:string;size:string;mime:string};
};
type User = {id:string;email:string;displayName:string;role:string};

const navItems = [MessageCircle, Users, Send, Star, Clock3, Archive];

export function WhatsAppInbox() {
  const [accounts,setAccounts]=useState<Account[]>([]);
  const [conversations,setConversations]=useState<Conversation[]>([]);
  const [messages,setMessages]=useState<Record<string,ChatMessage[]>>({});
  const [activeId,setActiveId]=useState("");
  const [selectedAccount,setSelectedAccount]=useState("");
  const [filter,setFilter]=useState("全部会话");
  const [query,setQuery]=useState("");
  const [draft,setDraft]=useState("");
  const [detailsOpen,setDetailsOpen]=useState(true);
  const [sidebarOpen,setSidebarOpen]=useState(false);
  const [toast,setToast]=useState("");
  const [apiToken,setApiToken]=useState("");
  const [user,setUser]=useState<User|null>(null);
  const [authOpen,setAuthOpen]=useState(true);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState("");

  const active=conversations.find(item=>item.id===activeId)??null;
  const userId=user?.id??tokenSubject(apiToken);
  const counts=useMemo(()=>({
    all:conversations.filter(item=>item.conversationStatus!=="archived").length,
    mine:conversations.filter(item=>item.assignedUserId===userId).length,
    unassigned:conversations.filter(item=>!item.assignedUserId).length,
    favorite:conversations.filter(item=>item.favorite).length,
    closed:conversations.filter(item=>item.conversationStatus==="closed").length,
  }),[conversations,userId]);
  const visible=useMemo(()=>conversations.filter(item=>{
    if(selectedAccount&&item.accountId!==selectedAccount)return false;
    if(!`${item.name} ${item.phone} ${item.preview}`.toLowerCase().includes(query.toLowerCase()))return false;
    if(filter==="分配给我")return item.assignedUserId===userId;
    if(filter==="未分配")return !item.assignedUserId;
    if(filter==="收藏")return item.favorite;
    if(filter==="已关闭")return item.conversationStatus==="closed";
    return item.conversationStatus!=="archived";
  }),[conversations,selectedAccount,query,filter,userId]);
  const currentMessages=active?messages[active.id]??[]:[];

  const logout=useCallback(()=>{
    sessionStorage.removeItem("relayAccessToken");sessionStorage.removeItem("relayUser");
    setApiToken("");setUser(null);setAccounts([]);setConversations([]);setMessages({});setActiveId("");setAuthOpen(true);setLoading(false);
  },[]);

  const loadWorkspace=useCallback(async(token:string,quiet=false)=>{
    if(!quiet)setLoading(true);setLoadError("");
    try{
      const [accountResult,conversationResult]=await Promise.all([
        authorizedFetch("/api/v1/accounts",token),authorizedFetch("/api/v1/conversations?limit=100",token),
      ]);
      const accountResponse=accountResult.response,conversationResponse=conversationResult.response;
      const refreshedToken=accountResult.token!==token?accountResult.token:conversationResult.token;
      if(refreshedToken!==token)setApiToken(refreshedToken);
      if(accountResponse.status===401||conversationResponse.status===401){logout();return;}
      if(!accountResponse.ok||!conversationResponse.ok)throw new Error(`中心 API 响应异常（${accountResponse.status}/${conversationResponse.status}）`);
      const accountBody=await accountResponse.json() as {data:Array<Record<string,unknown>>};
      const conversationBody=await conversationResponse.json() as {data:Array<Record<string,unknown>>};
      setAccounts(accountBody.data.map(item=>({id:String(item.id),name:String(item.display_name),phone:String(item.phone_e164??""),status:String(item.status),reason:String(item.status_reason??""),lastEvent:item.last_event_at?String(item.last_event_at):undefined})));
      const mapped=conversationBody.data.map((item,index)=>mapConversation(item,index));
      setConversations(mapped);setActiveId(previous=>mapped.some(item=>item.id===previous)?previous:(mapped[0]?.id??""));
    }catch(error){setLoadError(error instanceof Error?error.message:"中心数据加载失败");}
    finally{if(!quiet)setLoading(false);}
  },[logout]);

  const loadMessages=useCallback(async(token:string,conversationId:string,markRead=false)=>{
    try{
      const result=await authorizedFetch(`/api/v1/conversations/${conversationId}/messages?limit=100`,token);
      const response=result.response;if(result.token!==token)setApiToken(result.token);
      if(response.status===401){logout();return;}if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const body=await response.json() as {data:Array<Record<string,unknown>>};
      setMessages(all=>({...all,[conversationId]:body.data.map(mapMessage)}));
      if(markRead)await authorizedFetch(`/api/v1/conversations/${conversationId}`,result.token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({read:true})});
    }catch{setToast("消息加载失败，正在等待下次同步");}
  },[logout]);

  useEffect(()=>{
    const timer=window.setTimeout(()=>{
      const token=sessionStorage.getItem("relayAccessToken")??"";
      const storedUser=sessionStorage.getItem("relayUser");
      if(!token){setLoading(false);setAuthOpen(true);return;}
      setApiToken(token);if(storedUser)try{setUser(JSON.parse(storedUser) as User);}catch{}
      setAuthOpen(false);void loadWorkspace(token);
    },0);
    return()=>window.clearTimeout(timer);
  },[loadWorkspace]);

  useEffect(()=>{if(!apiToken)return;const timer=window.setInterval(()=>void loadWorkspace(apiToken,true),5000);return()=>window.clearInterval(timer);},[apiToken,loadWorkspace]);
  useEffect(()=>{if(!apiToken||!activeId)return;const initial=window.setTimeout(()=>void loadMessages(apiToken,activeId,true),0);const timer=window.setInterval(()=>void loadMessages(apiToken,activeId),3000);return()=>{window.clearTimeout(initial);window.clearInterval(timer);};},[apiToken,activeId,loadMessages]);

  async function updateConversation(change:Record<string,unknown>){
    if(!active||!apiToken)return;
    const result=await authorizedFetch(`/api/v1/conversations/${active.id}`,apiToken,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(change)});const response=result.response;if(result.token!==apiToken)setApiToken(result.token);
    if(!response.ok){setToast(`操作失败（HTTP ${response.status}）`);return;}await loadWorkspace(apiToken,true);
  }

  async function sendMessage(){
    if(!active||!apiToken||!draft.trim())return;
    const text=draft.trim();const clientMessageId=crypto.randomUUID();setDraft("");
    setMessages(all=>({...all,[active.id]:[...(all[active.id]??[]),{id:clientMessageId,direction:"out",kind:"text",text,time:formatTime(new Date()),status:"queued"}]}));
    const result=await authorizedFetch("/api/v1/messages",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId:active.accountId,conversationId:active.id,clientMessageId,type:"text",text})});const response=result.response;if(result.token!==apiToken)setApiToken(result.token);
    if(!response.ok){setToast(`消息入队失败（HTTP ${response.status}）`);setMessages(all=>({...all,[active.id]:(all[active.id]??[]).map(item=>item.id===clientMessageId?{...item,status:"failed"}:item)}));return;}
    setToast(active.accountStatus==="online"?"消息已进入发送队列":"账号离线，消息已持久化排队");void loadMessages(apiToken,active.id);
  }

  const onlineCount=accounts.filter(item=>item.status==="online").length;
  const profileText=(user?.displayName||user?.email||"坐席").slice(0,1).toUpperCase();

  return <main className="relay-shell">
    {toast&&<div className="toast"><Check size={15}/>{toast}</div>}
    <nav className="rail" aria-label="全局导航"><button className="brand-mark" aria-label="RelayDesk"><Sparkles size={19}/></button><div className="rail-nav">{navItems.map((Icon,index)=><button key={index} className={index===0?"rail-button active":"rail-button"} aria-label={["消息","联系人","发送","收藏","历史","归档"][index]}><Icon size={18}/></button>)}</div><div className="rail-bottom"><button className="rail-button" aria-label="帮助"><CircleHelp size={18}/></button><button className="rail-button" onClick={()=>setAuthOpen(true)} aria-label="设置与 Agent 注册"><Settings size={18}/></button><button className="profile-button" onClick={()=>setAuthOpen(true)} aria-label="账户"><span className="avatar small coral">{profileText}</span></button></div></nav>

    <aside className={`filters ${sidebarOpen?"mobile-open":""}`}><div className="mobile-filter-head"><b>收件箱</b><button onClick={()=>setSidebarOpen(false)} aria-label="关闭筛选"><X size={18}/></button></div><div className="workspace-title"><div><span className="eyebrow">工作空间</span><h1>消息中心</h1></div><button onClick={()=>void loadWorkspace(apiToken)} aria-label="刷新"><RefreshCw size={16}/></button></div>
      <label className="account-switcher"><span className="wa-dot"><Phone size={13}/></span><span><b>WhatsApp 账号</b><small>{onlineCount} 在线 · {accounts.length-onlineCount} 离线</small></span><ChevronDown size={15}/><select aria-label="筛选 WhatsApp 账号" value={selectedAccount} onChange={event=>setSelectedAccount(event.target.value)}><option value="">全部账号</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <section><p className="section-label">收件箱</p>{[
        {label:"全部会话",icon:Inbox,count:counts.all},{label:"分配给我",icon:Users,count:counts.mine},{label:"未分配",icon:UserPlus,count:counts.unassigned},{label:"收藏",icon:Star,count:counts.favorite},{label:"已关闭",icon:Check,count:counts.closed},
      ].map(({label,icon:Icon,count})=><button key={label} onClick={()=>{setFilter(label);setSidebarOpen(false)}} className={filter===label?"filter-row selected":"filter-row"}><span><Icon size={15}/>{label}</span><em>{count}</em></button>)}</section>
      <section className="accounts-block"><p className="section-label">账号连接</p>{accounts.length?accounts.map((account,index)=><AccountStatus key={account.id} initials={account.name.slice(0,2).toUpperCase()} color={["green","blue","gray"][index%3]} name={account.name} detail={account.status==="online"?"已连接":account.reason||statusText(account.status)} online={account.status==="online"}/>):<p className="empty-note">暂无已绑定账号</p>}</section>
    </aside>

    <section className="conversation-panel"><header className="conversation-head"><button className="mobile-menu" onClick={()=>setSidebarOpen(true)} aria-label="打开筛选"><Menu size={18}/></button><div><h2>{filter}</h2><span>{visible.length} 个真实会话</span></div><button className="icon-button" onClick={()=>void loadWorkspace(apiToken)} aria-label="刷新"><RefreshCw size={17}/></button></header><label className="search-box"><Search size={15}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索会话、联系人或号码"/></label><div className="conversation-list">{loading?<EmptyState title="正在读取中心数据" text="请稍候…"/>:loadError?<EmptyState title="中心数据加载失败" text={loadError}/>:visible.length?visible.map(item=><button key={item.id} onClick={()=>setActiveId(item.id)} className={item.id===activeId?"conversation active":"conversation"}><span className="avatar" style={{background:item.color}}>{item.initials}<i className={`presence ${item.accountStatus==="online"?"online":"offline"}`}/></span><span className="conversation-copy"><span className="conversation-line"><b>{item.name}</b><time>{item.time}</time></span><span className="conversation-line preview"><span>{item.preview}</span>{item.unread>0&&<em>{item.unread}</em>}</span><small>{item.account} · {item.assignedUserId?"已分配":"未分配"}</small></span></button>):<EmptyState title="暂无真实会话" text={accounts.length?"该账号尚未收到一对一消息":"请先在 Windows Agent 绑定 WhatsApp 账号"}/>}</div></section>

    <section className="chat-panel">{active?<><header className="chat-head"><div className="chat-person"><span className="avatar" style={{background:active.color}}>{active.initials}</span><span><b>{active.name}</b><small><i className={`status-dot ${active.accountStatus==="online"?"online":""}`}/>{active.account} · {statusText(active.accountStatus)}</small></span></div><div className="chat-actions"><button onClick={()=>void updateConversation({assignedToMe:active.assignedUserId!==userId})} className="assign-button"><UserPlus size={15}/>{active.assignedUserId===userId?"取消认领":active.assignedUserId?"转为我负责":"认领"}</button><button onClick={()=>void updateConversation({favorite:!active.favorite})} className="icon-button" aria-label="收藏"><Bookmark size={17} fill={active.favorite?"currentColor":"none"}/></button><button onClick={()=>setDetailsOpen(!detailsOpen)} className="icon-button" aria-label="联系人详情"><Info size={17}/></button></div></header>{active.accountStatus!=="online"&&<div className="offline-banner"><WifiOff size={15}/><span>该账号当前离线；发送请求仍会进入持久队列。</span></div>}<div className="messages" aria-live="polite"><div className="day-separator"><span>真实消息记录</span></div>{currentMessages.length?currentMessages.map(message=><article key={message.id} className={`message-row ${message.direction}`}>{message.direction==="in"&&<span className="avatar message-avatar" style={{background:active.color}}>{active.initials}</span>}<div className="message-bubble"><p>{message.text}</p>{message.attachment&&<div className="attachment-card"><span><FileText size={20}/></span><span><b>{message.attachment.name}</b><small>{message.attachment.mime} · {message.attachment.size}</small></span></div>}<footer><time>{message.time}</time>{message.direction==="out"&&<MessageStatus status={message.status}/>}</footer></div></article>):<EmptyState title="暂无消息" text="收到或发送的消息将显示在这里"/>}</div><div className="composer-wrap"><div className="composer-tools"><button aria-label="添加附件" disabled><Paperclip size={17}/></button><span>回复给 {active.name}</span></div><div className="composer"><textarea value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();void sendMessage();}}} placeholder="输入消息，Enter 发送，Shift + Enter 换行"/><div className="composer-icons"><button aria-label="表情" disabled><Smile size={18}/></button><button aria-label="录音" disabled><Mic size={18}/></button><button onClick={()=>void sendMessage()} className="send-button" aria-label="发送"><Send size={18}/></button></div></div><p className="delivery-hint">{active.accountStatus==="online"?<><Wifi size={13}/>Agent 在线</>:<><Clock3 size={13}/>离线队列已启用</>}</p></div></>:<div className="chat-empty"><MessageCircle size={31}/><h2>选择一个真实会话</h2><p>这里不会再显示演示联系人或模拟消息。</p></div>}</section>

    {detailsOpen&&active&&<aside className="details-panel"><header><h3>联系人详情</h3><button onClick={()=>setDetailsOpen(false)} className="icon-button" aria-label="关闭详情"><X size={17}/></button></header><div className="contact-card"><span className="avatar large" style={{background:active.color}}>{active.initials}</span><h2>{active.name}</h2><p>{active.phone||"号码待同步"}</p><span className="contact-online"><i className={`status-dot ${active.accountStatus==="online"?"online":""}`}/>{statusText(active.accountStatus)}</span></div><div className="detail-section"><h4>会话信息</h4><dl><div><dt>负责坐席</dt><dd>{active.assignedUserId===userId?"我":active.assignedUserId?"其他坐席":"未分配"}</dd></div><div><dt>接入账号</dt><dd>{active.account}</dd></div><div><dt>未读消息</dt><dd>{active.unread}</dd></div><div><dt>会话状态</dt><dd className="green-text">{active.conversationStatus==="open"?"进行中":active.conversationStatus==="closed"?"已关闭":"已归档"}</dd></div></dl><button className="conversation-state-button" onClick={()=>void updateConversation({status:active.conversationStatus==="closed"?"open":"closed"})}>{active.conversationStatus==="closed"?"重新打开会话":"关闭会话"}</button></div><div className="security-note"><ShieldCheck size={16}/><span><b>中心真实数据</b><small>消息来自 PostgreSQL 与本地 Agent 同步</small></span></div></aside>}

    {authOpen&&<LoginDialog
      connected={Boolean(apiToken)} token={apiToken} canClose={Boolean(apiToken)}
      onClose={()=>setAuthOpen(false)}
      onLogin={(token,nextUser)=>{sessionStorage.setItem("relayAccessToken",token);sessionStorage.setItem("relayUser",JSON.stringify(nextUser));setApiToken(token);setUser(nextUser);setAuthOpen(false);void loadWorkspace(token);}}
      onLogout={logout}
    />}
  </main>;
}

function mapConversation(item:Record<string,unknown>,index:number):Conversation {const name=String(item.display_name??item.phone_e164??"未知联系人");return{id:String(item.id),name,initials:name.slice(0,2).toUpperCase(),color:COLORS[index%COLORS.length],account:String(item.account_name??"未知账号"),accountId:String(item.account_id),phone:String(item.phone_e164??""),preview:String(item.last_message??kindText(String(item.last_message_kind??""))),time:item.last_message_at?formatTime(new Date(String(item.last_message_at))):"",unread:Number(item.unread_count??0),accountStatus:String(item.account_status??"offline"),assignedUserId:item.assigned_user_id?String(item.assigned_user_id):null,favorite:Boolean(item.favorite),conversationStatus:String(item.status??"open")};}
function mapMessage(item:Record<string,unknown>):ChatMessage {const kind=String(item.kind??"text");return{id:String(item.id),direction:item.direction as "in"|"out",kind,text:String(item.text_content??kindText(kind)),time:formatTime(new Date(String(item.occurred_at))),status:item.status as ChatMessage["status"],attachment:item.file_name?{name:String(item.file_name),mime:String(item.mime_type??"文件"),size:formatBytes(Number(item.byte_size??0))}:undefined};}
function kindText(kind:string){return({audio:"[语音消息]",image:"[图片]",video:"[视频]",document:"[文档]",location:"[位置]",contact:"[联系人名片]"} as Record<string,string>)[kind]??"暂无消息";}
function statusText(status:string){return({online:"在线",pairing:"等待配对",offline:"离线",logged_out:"已退出",error:"异常"} as Record<string,string>)[status]??status;}
function formatTime(date:Date){return Number.isNaN(date.getTime())?"":date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});}
function formatBytes(size:number){if(size<1024)return`${size} B`;if(size<1048576)return`${(size/1024).toFixed(1)} KB`;return`${(size/1048576).toFixed(1)} MB`;}
function tokenSubject(token:string){try{return String(JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).sub??"");}catch{return"";}}
async function authorizedFetch(path:string,token:string,init:RequestInit={}):Promise<{response:Response;token:string}>{
  const send=(accessToken:string)=>fetch(`${API_URL}${path}`,{...init,credentials:"include",headers:{...init.headers,authorization:`Bearer ${accessToken}`}});
  let response=await send(token);if(response.status!==401)return{response,token};
  refreshPromise??=refreshAccessToken();
  let refreshedToken="";try{refreshedToken=await refreshPromise;}finally{refreshPromise=null;}
  if(!refreshedToken)return{response,token};
  sessionStorage.setItem("relayAccessToken",refreshedToken);response=await send(refreshedToken);return{response,token:refreshedToken};
}
async function refreshAccessToken(){const response=await fetch(`${API_URL}/api/v1/auth/refresh`,{method:"POST",credentials:"include"});if(!response.ok)return"";const body=await response.json() as {accessToken?:string};return body.accessToken??"";}

function EmptyState({title,text}:{title:string;text:string}){return <div className="empty-state"><b>{title}</b><span>{text}</span></div>;}
function AccountStatus({initials,color,name,detail,online=false}:{initials:string;color:string;name:string;detail:string;online?:boolean}){return <div className={`account-status ${online?"":"muted"}`}><span className={`avatar tiny ${color}`}>{initials}</span><span><b>{name}</b><small><i className={`status-dot ${online?"online":""}`}/>{detail}</small></span></div>;}
function MessageStatus({status}:{status?:ChatMessage["status"]}){if(status==="queued"||status==="dispatching")return <span className="message-state queued"><Clock3 size={12}/>{status==="queued"?"排队中":"发送中"}</span>;if(status==="failed"||status==="uncertain")return <span className="message-state failed"><X size={12}/>{status==="failed"?"失败":"待确认"}</span>;if(status==="read")return <span className="message-state read"><CheckCheck size={13}/>已读</span>;if(status==="delivered")return <span className="message-state"><CheckCheck size={13}/>已送达</span>;return <span className="message-state"><Check size={13}/>已发送</span>;}

function LoginDialog({connected,token,canClose,onClose,onLogin,onLogout}:{connected:boolean;token:string;canClose:boolean;onClose:()=>void;onLogin:(token:string,user:User)=>void;onLogout:()=>void}){
  const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [agentName,setAgentName]=useState("Windows Agent");const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);const [copied,setCopied]=useState(false);
  async function submit(){setBusy(true);setError("");try{const response=await fetch(`${API_URL}/api/v1/auth/login`,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});const body=await response.json() as {accessToken?:string;user?:User;error?:string};if(!response.ok||!body.accessToken||!body.user)throw new Error(response.status===401?"邮箱或密码错误":`登录失败（HTTP ${response.status}）`);onLogin(body.accessToken,body.user);}catch(reason){setError(reason instanceof Error?reason.message:"登录失败");}finally{setBusy(false);}}
  async function createEnrollment(){setBusy(true);setError("");setEnrollment(null);try{const response=await fetch(`${API_URL}/api/v1/agents/enrollment`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:agentName.trim()||"Windows Agent"})});if(response.status===401)throw new Error("登录已过期");if(response.status===403)throw new Error("只有管理员可以生成注册码");if(!response.ok)throw new Error(`注册码生成失败（HTTP ${response.status}）`);const body=await response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});}catch(reason){setError(reason instanceof Error?reason.message:"注册码生成失败");}finally{setBusy(false);}}
  async function copyEnrollment(){if(!enrollment)return;try{await navigator.clipboard.writeText(enrollment.code);setCopied(true);window.setTimeout(()=>setCopied(false),1500);}catch{setError("剪贴板不可用，请手动复制");}}
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(canClose&&event.target===event.currentTarget)onClose();}}><section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">{canClose&&<button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button>}<span className="login-logo"><ShieldCheck size={21}/></span><h2 id="login-title">{connected?"中心设置":"登录 RelayDesk"}</h2><p>{connected?"生成 Agent 一次性注册码，或退出当前坐席。":"登录后只展示中心数据库中的真实账号、会话与消息。"}</p>{connected?<><div className="center-endpoint"><span>中心地址</span><strong>{API_URL||"当前站点"}</strong></div><label>Agent 设备名称<input value={agentName} onChange={event=>setAgentName(event.target.value)} maxLength={80}/></label><button className="login-submit" disabled={busy} onClick={()=>void createEnrollment()}>{busy?"正在生成...":"生成一次性注册码"}</button>{enrollment&&<div className="enrollment-result"><span>一次性注册码</span><code>{enrollment.code}</code><small>有效期至 {new Date(enrollment.expiresAt).toLocaleString("zh-CN")}</small><button onClick={()=>void copyEnrollment()}>{copied?"已复制":"复制注册码"}</button></div>}{error&&<span className="login-error">{error}</span>}<button className="login-submit danger" onClick={onLogout}>退出中心平台</button></>:<><label>邮箱<input value={email} onChange={event=>setEmail(event.target.value)} autoComplete="username" autoFocus/></label><label>密码<input type="password" value={password} onChange={event=>setPassword(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")void submit();}} autoComplete="current-password"/></label>{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!email||!password} onClick={()=>void submit()}>{busy?"正在连接...":"登录并加载真实数据"}</button></>}</section></div>;
}
