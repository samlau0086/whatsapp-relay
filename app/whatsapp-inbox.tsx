"use client";

import {
  Archive, Bookmark, Check, CheckCheck, ChevronDown, CircleHelp, Clock3, FileText,
  Inbox, Info, Menu, MessageCircle, Mic, MonitorSmartphone, Paperclip, Phone, Plus,
  RefreshCw, Search, Send, Settings, ShieldCheck, Smile, Sparkles, Star, Trash2, UploadCloud, UserPlus,
  Users, Wifi, WifiOff, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";

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
  attachment?:{id:string;name:string;size:string;mime:string};
};
type User = {id:string;email:string;displayName:string;role:string};
type WorkspaceView = "inbox"|"agents"|"help";
type ManagedAgent = {id:string;name:string;status:string;version?:string;protocol_version?:number;platform?:string;last_seen_at?:string;last_acked_cursor:number;created_at:string;accounts:Array<{id:string;display_name:string;phone_e164?:string;status:string;status_reason?:string;last_event_at?:string}>};
type MediaAsset = {id:string;fileName:string;mimeType:string;size:number;sha256:string;createdAt:string;usageCount:number};

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
  const [authOpen,setAuthOpen]=useState(false);
  const [sessionReady,setSessionReady]=useState(false);
  const [loading,setLoading]=useState(true);
  const [loadError,setLoadError]=useState("");
  const [view,setView]=useState<WorkspaceView>("inbox");
  const [newConversationOpen,setNewConversationOpen]=useState(false);
  const [mediaOpen,setMediaOpen]=useState(false);
  const [emojiOpen,setEmojiOpen]=useState(false);
  const [emojiCategory,setEmojiCategory]=useState("常用");
  const textareaRef=useRef<HTMLTextAreaElement>(null);
  const messagesRef=useRef<HTMLDivElement>(null);

  const userId=user?.id??tokenSubject(apiToken);
  const counts=useMemo(()=>({
    all:conversations.filter(item=>item.conversationStatus!=="archived").length,
    mine:conversations.filter(item=>item.assignedUserId===userId).length,
    unassigned:conversations.filter(item=>!item.assignedUserId).length,
    favorite:conversations.filter(item=>item.favorite).length,
    closed:conversations.filter(item=>item.conversationStatus==="closed").length,
    archived:conversations.filter(item=>item.conversationStatus==="archived").length,
  }),[conversations,userId]);
  const visible=useMemo(()=>conversations.filter(item=>{
    if(selectedAccount&&item.accountId!==selectedAccount)return false;
    if(!`${item.name} ${item.phone} ${item.preview}`.toLowerCase().includes(query.toLowerCase()))return false;
    if(filter==="分配给我")return item.assignedUserId===userId;
    if(filter==="未分配")return !item.assignedUserId;
    if(filter==="收藏")return item.favorite;
    if(filter==="已关闭")return item.conversationStatus==="closed";
    if(filter==="已归档")return item.conversationStatus==="archived";
    return item.conversationStatus!=="archived";
  }),[conversations,selectedAccount,query,filter,userId]);
  const effectiveActiveId=visible.some(item=>item.id===activeId)?activeId:(visible[0]?.id??"");
  const active=visible.find(item=>item.id===effectiveActiveId)??null;
  const currentMessages=active?messages[active.id]??[]:[];
  const latestMessageId=currentMessages.at(-1)?.id??"";
  const scrollMessagesToEnd=useCallback((behavior:ScrollBehavior="smooth")=>{
    window.requestAnimationFrame(()=>{
      const container=messagesRef.current;
      if(container)container.scrollTo({top:container.scrollHeight,behavior});
    });
  },[]);

  useEffect(()=>{
    if(effectiveActiveId)scrollMessagesToEnd("auto");
  },[effectiveActiveId,scrollMessagesToEnd]);

  useEffect(()=>{
    if(latestMessageId)scrollMessagesToEnd("smooth");
  },[latestMessageId,scrollMessagesToEnd]);

  const logout=useCallback(()=>{
    sessionStorage.removeItem("relayAccessToken");sessionStorage.removeItem("relayUser");
    setApiToken("");setUser(null);setAccounts([]);setConversations([]);setMessages({});setActiveId("");setAuthOpen(false);setSessionReady(true);setLoading(false);
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
      if(!token){setLoading(false);setSessionReady(true);return;}
      setApiToken(token);if(storedUser)try{setUser(JSON.parse(storedUser) as User);}catch{}
      setAuthOpen(false);setSessionReady(true);void loadWorkspace(token);
    },0);
    return()=>window.clearTimeout(timer);
  },[loadWorkspace]);

  useEffect(()=>{if(!apiToken)return;const timer=window.setInterval(()=>void loadWorkspace(apiToken,true),5000);return()=>window.clearInterval(timer);},[apiToken,loadWorkspace]);
  useEffect(()=>{if(!apiToken||!effectiveActiveId)return;const initial=window.setTimeout(()=>void loadMessages(apiToken,effectiveActiveId,true),0);const timer=window.setInterval(()=>void loadMessages(apiToken,effectiveActiveId),3000);return()=>{window.clearTimeout(initial);window.clearInterval(timer);};},[apiToken,effectiveActiveId,loadMessages]);
  useEffect(()=>{if(!toast)return;const timer=window.setTimeout(()=>setToast(""),3200);return()=>window.clearTimeout(timer);},[toast]);

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

  async function sendMediaAsset(asset:MediaAsset,caption:string){
    if(!active||!apiToken)return;
    const kind=mediaKind(asset.mimeType),clientMessageId=crypto.randomUUID();setDraft("");
    setMessages(all=>({...all,[active.id]:[...(all[active.id]??[]),{id:clientMessageId,direction:"out",kind,text:caption,time:formatTime(new Date()),status:"queued",attachment:{id:asset.id,name:asset.fileName,mime:asset.mimeType,size:formatBytes(asset.size)}}]}));
    const queued=await authorizedFetch("/api/v1/messages",apiToken,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId:active.accountId,conversationId:active.id,clientMessageId,type:kind,text:caption||undefined,mediaId:asset.id})});if(queued.token!==apiToken)setApiToken(queued.token);
    if(!queued.response.ok){setToast(`附件消息入队失败（HTTP ${queued.response.status}）`);setMessages(all=>({...all,[active.id]:(all[active.id]??[]).map(item=>item.id===clientMessageId?{...item,status:"failed"}:item)}));return;}
    setMediaOpen(false);setToast(active.accountStatus==="online"?"附件已进入发送队列":"账号离线，附件已持久化排队");void loadMessages(queued.token,active.id);
  }

  function insertEmoji(emoji:string){const input=textareaRef.current,start=input?.selectionStart??draft.length,end=input?.selectionEnd??start;setDraft(`${draft.slice(0,start)}${emoji}${draft.slice(end)}`);requestAnimationFrame(()=>{input?.focus();input?.setSelectionRange(start+emoji.length,start+emoji.length);});}

  const onlineCount=accounts.filter(item=>item.status==="online").length;
  const profileText=(user?.displayName||user?.email||"坐席").slice(0,1).toUpperCase();
  const userRole=user?.role||tokenRole(apiToken);
  const openInbox=(nextFilter="全部会话")=>{setView("inbox");setFilter(nextFilter);};
  const completeLogin=(token:string,nextUser:User)=>{sessionStorage.setItem("relayAccessToken",token);sessionStorage.setItem("relayUser",JSON.stringify(nextUser));setApiToken(token);setUser(nextUser);setAuthOpen(false);setSessionReady(true);void loadWorkspace(token);};

  if(!sessionReady)return <AccessPortal loading onLogin={()=>{}}/>;
  if(!apiToken)return <><AccessPortal loading={false} onLogin={()=>setAuthOpen(true)}/>{authOpen&&<LoginDialog connected={false} token="" canClose onClose={()=>setAuthOpen(false)} onLogin={completeLogin} onLogout={logout}/>}</>;

  return <main className="relay-shell">
    {toast&&<div className="toast"><Check size={15}/>{toast}</div>}
    <nav className="rail" aria-label="全局导航"><button className="brand-mark" onClick={()=>openInbox()} aria-label="RelayDesk 消息中心"><Sparkles size={19}/></button><div className="rail-nav">
      <button className={view==="inbox"&&filter==="全部会话"?"rail-button active":"rail-button"} onClick={()=>openInbox()} aria-label="消息中心" title="消息中心"><MessageCircle size={18}/></button>
      <button className={view==="agents"?"rail-button active":"rail-button"} onClick={()=>setView("agents")} aria-label="Agent 管理" title="Agent 管理"><MonitorSmartphone size={18}/></button>
      <button className="rail-button" onClick={()=>{openInbox();window.setTimeout(()=>{const composer=document.querySelector<HTMLTextAreaElement>(".composer textarea");if(composer)composer.focus();else setToast("请先选择一个真实会话");},0);}} aria-label="发送消息" title="发送消息"><Send size={18}/></button>
      <button className={view==="inbox"&&filter==="收藏"?"rail-button active":"rail-button"} onClick={()=>openInbox("收藏")} aria-label="收藏会话" title="收藏会话"><Star size={18}/></button>
      <button className={view==="inbox"&&filter==="已关闭"?"rail-button active":"rail-button"} onClick={()=>openInbox("已关闭")} aria-label="已关闭会话" title="已关闭会话"><Clock3 size={18}/></button>
      <button className={view==="inbox"&&filter==="已归档"?"rail-button active":"rail-button"} onClick={()=>openInbox("已归档")} aria-label="已归档会话" title="已归档会话"><Archive size={18}/></button>
    </div><div className="rail-bottom"><button className={view==="help"?"rail-button active":"rail-button"} onClick={()=>setView("help")} aria-label="帮助" title="帮助"><CircleHelp size={18}/></button><button className="rail-button" onClick={()=>setAuthOpen(true)} aria-label="中心设置" title="中心设置"><Settings size={18}/></button><button className="profile-button" onClick={()=>setAuthOpen(true)} aria-label="账户"><span className="avatar small coral">{profileText}</span></button></div></nav>

    {view==="inbox"?<><aside className={`filters ${sidebarOpen?"mobile-open":""}`}><div className="mobile-filter-head"><b>收件箱</b><button onClick={()=>setSidebarOpen(false)} aria-label="关闭筛选"><X size={18}/></button></div><div className="workspace-title"><div><span className="eyebrow">工作空间</span><h1>消息中心</h1></div><button onClick={()=>setNewConversationOpen(true)} aria-label="新建会话" title="新建会话"><Plus size={16}/></button></div>
      <label className="account-switcher"><span className="wa-dot"><Phone size={13}/></span><span><b>WhatsApp 账号</b><small>{onlineCount} 在线 · {accounts.length-onlineCount} 离线</small></span><ChevronDown size={15}/><select aria-label="筛选 WhatsApp 账号" value={selectedAccount} onChange={event=>setSelectedAccount(event.target.value)}><option value="">全部账号</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <section><p className="section-label">收件箱</p>{[
        {label:"全部会话",icon:Inbox,count:counts.all},{label:"分配给我",icon:Users,count:counts.mine},{label:"未分配",icon:UserPlus,count:counts.unassigned},{label:"收藏",icon:Star,count:counts.favorite},{label:"已关闭",icon:Check,count:counts.closed},{label:"已归档",icon:Archive,count:counts.archived},
      ].map(({label,icon:Icon,count})=><button key={label} onClick={()=>{setFilter(label);setSidebarOpen(false)}} className={filter===label?"filter-row selected":"filter-row"}><span><Icon size={15}/>{label}</span><em>{count}</em></button>)}</section>
      <section className="accounts-block"><p className="section-label">账号连接</p>{accounts.length?accounts.map((account,index)=><AccountStatus key={account.id} initials={account.name.slice(0,2).toUpperCase()} color={["green","blue","gray"][index%3]} name={account.name} detail={account.status==="online"?"已连接":account.reason||statusText(account.status)} online={account.status==="online"}/>):<p className="empty-note">暂无已绑定账号</p>}</section>
    </aside>

    <section className="conversation-panel"><header className="conversation-head"><button className="mobile-menu" onClick={()=>setSidebarOpen(true)} aria-label="打开筛选"><Menu size={18}/></button><div><h2>{filter}</h2><span>{visible.length} 个真实会话</span></div><button className="icon-button" onClick={()=>void loadWorkspace(apiToken)} aria-label="刷新"><RefreshCw size={17}/></button></header><label className="search-box"><Search size={15}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索会话、联系人或号码"/></label><div className="conversation-list">{loading?<EmptyState title="正在读取中心数据" text="请稍候…"/>:loadError?<EmptyState title="中心数据加载失败" text={loadError}/>:visible.length?visible.map(item=><button key={item.id} onClick={()=>setActiveId(item.id)} className={item.id===effectiveActiveId?"conversation active":"conversation"}><span className="avatar" style={{background:item.color}}>{item.initials}<i className={`presence ${item.accountStatus==="online"?"online":"offline"}`}/></span><span className="conversation-copy"><span className="conversation-line"><b>{item.name}</b><time>{item.time}</time></span><span className="conversation-line preview"><span>{item.preview}</span>{item.unread>0&&<em>{item.unread}</em>}</span><small>{item.account} · {item.assignedUserId?"已分配":"未分配"}</small></span></button>):<EmptyState title="暂无真实会话" text={accounts.length?"该账号尚未收到一对一消息":"请先在 Windows Agent 绑定 WhatsApp 账号"}/>}</div></section>

    <section className="chat-panel">{active?<>
      <header className="chat-head"><div className="chat-person"><span className="avatar" style={{background:active.color}}>{active.initials}</span><span><b>{active.name}</b><small><i className={`status-dot ${active.accountStatus==="online"?"online":""}`}/>{active.account} · {statusText(active.accountStatus)}</small></span></div><div className="chat-actions"><button onClick={()=>void updateConversation({assignedToMe:active.assignedUserId!==userId})} className="assign-button"><UserPlus size={15}/>{active.assignedUserId===userId?"取消认领":active.assignedUserId?"转为我负责":"认领"}</button><button onClick={()=>void updateConversation({favorite:!active.favorite})} className="icon-button" aria-label="收藏"><Bookmark size={17} fill={active.favorite?"currentColor":"none"}/></button><button onClick={()=>setDetailsOpen(!detailsOpen)} className="icon-button" aria-label="联系人详情"><Info size={17}/></button></div></header>
      {active.accountStatus!=="online"&&<div className="offline-banner"><WifiOff size={15}/><span>该账号当前离线；发送请求仍会进入持久队列。</span></div>}
      <div ref={messagesRef} className="messages" aria-live="polite"><div className="day-separator"><span>真实消息记录</span></div>{currentMessages.length?currentMessages.map(message=><article key={message.id} className={`message-row ${message.direction}`}>{message.direction==="in"&&<span className="avatar message-avatar" style={{background:active.color}}>{active.initials}</span>}<div className={`message-bubble ${message.attachment?.name.startsWith("sticker-")?"sticker-bubble":""}`}>{message.text&&<p>{message.text}</p>}{message.attachment&&<MessageMedia attachment={message.attachment} token={apiToken} onToken={setApiToken} onReady={scrollMessagesToEnd}/>}<footer><time>{message.time}</time>{message.direction==="out"&&<MessageStatus status={message.status}/>}</footer></div></article>):<EmptyState title="暂无消息" text="收到或发送的消息将显示在这里"/>}</div>
      <div className="composer-wrap">
        <div className="composer-tools"><button onClick={()=>setMediaOpen(true)} aria-label="打开媒体与附件" title="媒体与附件"><Paperclip size={17}/></button><span>回复给 {active.name}</span></div>
        {emojiOpen&&<EmojiPicker category={emojiCategory} onCategory={setEmojiCategory} onSelect={insertEmoji} onClose={()=>setEmojiOpen(false)}/>}
        <div className="composer"><textarea ref={textareaRef} value={draft} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();void sendMessage();}if(event.key==="Escape")setEmojiOpen(false);}} placeholder="输入消息，Enter 发送，Shift + Enter 换行"/><div className="composer-icons"><button className={emojiOpen?"active":""} onClick={()=>setEmojiOpen(value=>!value)} aria-label="选择表情" title="选择表情"><Smile size={18}/></button><button onClick={()=>setToast("语音录制尚未启用，可先上传 OGG 或 MP3 语音文件")} aria-label="录音说明" title="录音说明"><Mic size={18}/></button><button onClick={()=>void sendMessage()} className="send-button" aria-label="发送"><Send size={18}/></button></div></div>
        <p className="delivery-hint">{active.accountStatus==="online"?<><Wifi size={13}/>Agent 在线</>:<><Clock3 size={13}/>离线队列已启用</>}</p>
      </div>
    </>:<div className="chat-empty"><MessageCircle size={31}/><h2>选择一个真实会话</h2><p>这里不会再显示演示联系人或模拟消息。</p></div>}</section>

    {detailsOpen&&active&&<aside className="details-panel"><header><h3>联系人详情</h3><button onClick={()=>setDetailsOpen(false)} className="icon-button" aria-label="关闭详情"><X size={17}/></button></header><div className="contact-card"><span className="avatar large" style={{background:active.color}}>{active.initials}</span><h2>{active.name}</h2><p>{active.phone||"号码待同步"}</p><span className="contact-online"><i className={`status-dot ${active.accountStatus==="online"?"online":""}`}/>{statusText(active.accountStatus)}</span></div><div className="detail-section"><h4>会话信息</h4><dl><div><dt>负责坐席</dt><dd>{active.assignedUserId===userId?"我":active.assignedUserId?"其他坐席":"未分配"}</dd></div><div><dt>接入账号</dt><dd>{active.account}</dd></div><div><dt>未读消息</dt><dd>{active.unread}</dd></div><div><dt>会话状态</dt><dd className="green-text">{active.conversationStatus==="open"?"进行中":active.conversationStatus==="closed"?"已关闭":"已归档"}</dd></div></dl><button className="conversation-state-button" onClick={()=>void updateConversation({status:active.conversationStatus==="closed"?"open":"closed"})}>{active.conversationStatus==="closed"?"重新打开会话":"关闭会话"}</button></div><div className="security-note"><ShieldCheck size={16}/><span><b>中心真实数据</b><small>消息来自 PostgreSQL 与本地 Agent 同步</small></span></div></aside>}</>
      :view==="agents"?<AgentManagement token={apiToken} role={userRole} onToken={setApiToken} onToast={setToast}/>
      :<HelpPanel onInbox={()=>openInbox()} onAgents={()=>setView("agents")}/>
    }

    {authOpen&&<LoginDialog
      connected={Boolean(apiToken)} token={apiToken} canClose={Boolean(apiToken)}
      onClose={()=>setAuthOpen(false)}
      onLogin={completeLogin}
      onLogout={logout}
    />}
    {newConversationOpen&&<NewConversationDialog accounts={accounts} token={apiToken} onToken={setApiToken} onClose={()=>setNewConversationOpen(false)} onCreated={async(conversationId,accountId,accessToken)=>{setNewConversationOpen(false);setView("inbox");setFilter("全部会话");setSelectedAccount(accountId);await loadWorkspace(accessToken,true);setActiveId(conversationId);setToast("新会话已创建，首条消息已进入发送队列");}}/>}
    {mediaOpen&&active&&<MediaDialog accountId={active.accountId} token={apiToken} initialCaption={draft} onToken={setApiToken} onToast={setToast} onClose={()=>setMediaOpen(false)} onSend={sendMediaAsset}/>}
  </main>;
}

function AccessPortal({loading,onLogin}:{loading:boolean;onLogin:()=>void}){
  return <main className="access-shell">
    <header className="access-header"><Link className="access-brand" href="/" aria-label="RelayDesk 主页"><span><Sparkles size={19}/></span><b>RelayDesk</b></Link><span className="operator-badge">由 GeekMT 运营</span></header>
    <section className="access-hero" aria-labelledby="access-title">
      <div className="access-copy"><span className="access-eyebrow">私有消息工作台</span><h1 id="access-title">清楚身份，再安全登录。</h1><p>RelayDesk 是 GeekMT 为获授权团队成员运营的内部消息工作台。这里使用的是 RelayDesk 坐席账号，不是 WhatsApp 或 Meta 账号。</p><button className="access-login" onClick={onLogin} disabled={loading}><ShieldCheck size={18}/>{loading?"正在检查会话…":"使用 RelayDesk 账号登录"}</button><small>没有账号？请联系你的 GeekMT 管理员。本站不会要求安装浏览器更新或远程控制软件。</small></div>
      <aside className="trust-card" aria-label="身份与安全说明"><div className="trust-card-head"><ShieldCheck size={24}/><span><b>登录前请确认</b><small>保护你的账号和个人信息</small></span></div><ul><li><b>独立服务</b><span>RelayDesk 不属于 WhatsApp LLC 或 Meta Platforms，也未获其赞助或背书。</span></li><li><b>专用凭据</b><span>只输入管理员发放的 RelayDesk 邮箱与密码。不要输入 WhatsApp / Meta 密码、短信验证码或两步验证 PIN。</span></li><li><b>授权访问</b><span>此工作台仅供获授权的 GeekMT 团队成员处理已许可的业务会话。</span></li></ul></aside>
    </section>
    <section className="access-purpose" aria-label="服务说明"><div><MessageCircle size={20}/><span><b>服务用途</b><small>集中处理经授权接入的客户消息</small></span></div><div><Wifi size={20}/><span><b>连接方式</b><small>通过受管的 RelayDesk Agent 同步</small></span></div><div><ShieldCheck size={20}/><span><b>凭据用途</b><small>仅验证 RelayDesk 坐席身份</small></span></div></section>
    <footer className="access-footer"><p><b>商标说明：</b>WhatsApp 是 WhatsApp LLC 的商标；Meta 是 Meta Platforms, Inc. 的商标。提及这些名称仅为说明兼容的消息渠道。</p><p>© {new Date().getFullYear()} GeekMT · RelayDesk 私有系统</p></footer>
  </main>;
}

const EMOJI_GROUPS:Record<string,string[]>={
  "常用":["😀","😂","😍","🥰","😊","🙏","👍","❤️","😭","😘","🤣","😁","🎉","🔥","👌","🤔","😅","😎","👏","💪","🙌","😉","😢","🤝"],
  "表情":["😀","😃","😄","😁","😆","😅","😂","🤣","🥲","☺️","😊","😇","🙂","🙃","😉","😌","😍","🥰","😘","😗","😙","😚","😋","😛","😝","😜","🤪","🤨","🧐","🤓","😎","🥳","😏","😒","😞","😔","😟","😕","🙁","☹️","😣","😖","😫","😩","🥺","😢","😭","😤","😠","😡","🤬","🤯","😳","🥵","🥶","😱","😨","😰","😥","😓","🤗","🤔","🫣","🤭","🫢","🤫","🤥","😶","😐","😑","😬","🙄","😯","😦","😧","😮","😲","🥱","😴","🤤","😪","😵","🤐","🤢","🤮","🤧","😷","🤒","🤕"],
  "手势":["👋","🤚","🖐️","✋","🖖","👌","🤌","🤏","✌️","🤞","🫰","🤟","🤘","🤙","👈","👉","👆","👇","☝️","🫵","👍","👎","✊","👊","🤛","🤜","👏","🙌","🫶","👐","🤲","🤝","🙏","✍️","💅","💪"],
  "动物":["🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐻‍❄️","🐨","🐯","🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐔","🐧","🐦","🐤","🦄","🐝","🦋","🐌","🐞","🐢","🐍","🦎","🐙","🦑","🦀","🐠","🐬","🐳","🌸","🌹","🌻","🌴","🌵","🍀"],
  "食物":["🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐","🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🥑","🥦","🥕","🌽","🌶️","🍞","🥐","🧀","🥚","🍔","🍟","🍕","🌭","🥪","🌮","🍜","🍣","🍱","🍚","🍰","🎂","🍫","🍿","☕","🍵","🥤","🍺","🍷"],
  "活动":["⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱","🏓","🏸","🏒","🏑","🥍","🏏","⛳","🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🚲","🏆","🥇","🎯","🎮","🎲","🎸","🎹","🎤","🎧","🎨","🎬","🎉","🎊"],
  "旅行":["🚗","🚕","🚌","🚎","🏎️","🚓","🚑","🚒","🚐","🛻","🚚","🚲","🛵","🏍️","✈️","🚀","🚁","⛵","🚢","🚆","🚇","🚉","🗺️","🗽","🗼","🏰","🏯","🏖️","🏝️","🏜️","🌋","⛰️","🏕️","🌅","🌇","🌃","🌍","🌎","🌏"],
  "符号":["❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔","❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️","✝️","☪️","🕉️","☯️","✡️","🔯","♈","♉","♊","♋","♌","♍","♎","♏","♐","♑","♒","♓","✅","❌","❗","❓","💯","⚠️","🔔","✨","🔥","⭐"]
};
const EMOJI_TABS:Record<string,string>={"常用":"🕘","表情":"😀","手势":"👋","动物":"🐻","食物":"🍔","活动":"⚽","旅行":"🚗","符号":"❤️"};

function EmojiPicker({category,onCategory,onSelect,onClose}:{category:string;onCategory:(value:string)=>void;onSelect:(emoji:string)=>void;onClose:()=>void}){return <section className="emoji-picker" role="dialog" aria-label="选择表情"><header><b>表情</b><button onClick={onClose} aria-label="关闭表情面板"><X size={15}/></button></header><nav>{Object.entries(EMOJI_TABS).map(([name,icon])=><button key={name} className={category===name?"active":""} onClick={()=>onCategory(name)} title={name} aria-label={name}>{icon}</button>)}</nav><div className="emoji-grid">{(EMOJI_GROUPS[category]??EMOJI_GROUPS["常用"]).map((emoji,index)=><button key={`${emoji}-${index}`} onClick={()=>onSelect(emoji)} aria-label={`插入 ${emoji}`}>{emoji}</button>)}</div></section>}

function MediaDialog({accountId,token,initialCaption,onToken,onToast,onClose,onSend}:{accountId:string;token:string;initialCaption:string;onToken:(token:string)=>void;onToast:(text:string)=>void;onClose:()=>void;onSend:(asset:MediaAsset,caption:string)=>Promise<void>}){
  const [assets,setAssets]=useState<MediaAsset[]>([]),[selectedId,setSelectedId]=useState(""),[query,setQuery]=useState(""),[filter,setFilter]=useState("all"),[caption,setCaption]=useState(initialCaption),[busy,setBusy]=useState(false),[dragging,setDragging]=useState(false),[error,setError]=useState("");const inputRef=useRef<HTMLInputElement>(null);
  const load=useCallback(async()=>{const result=await authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}&limit=100`,token);if(result.token!==token)onToken(result.token);if(!result.response.ok){setError(`媒体库加载失败（HTTP ${result.response.status}）`);return;}const body=await result.response.json() as {data:Array<Record<string,unknown>>};setAssets(body.data.map(mapMediaAsset));},[accountId,token,onToken]);
  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!busy)onClose();};window.addEventListener("keydown",key);return()=>window.removeEventListener("keydown",key);},[busy,onClose]);
  const visible=assets.filter(item=>(!query||item.fileName.toLowerCase().includes(query.toLowerCase()))&&(filter==="all"||mediaKind(item.mimeType)===filter)),selected=assets.find(item=>item.id===selectedId)??null;
  async function upload(files:FileList|File[]){const list=Array.from(files);if(!list.length)return;setBusy(true);setError("");try{let last:MediaAsset|null=null;for(const file of list){if(file.size>64*1024*1024)throw new Error(`${file.name} 超过 64 MB`);const form=new FormData();form.append("file",file);const result=await authorizedFetch(`/api/v1/media?accountId=${encodeURIComponent(accountId)}`,token,{method:"POST",body:form});if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`${file.name} 上传失败（HTTP ${result.response.status}）`);const body=await result.response.json() as {mediaId:string;fileName:string;mimeType:string;size:number;sha256:string};last={id:body.mediaId,fileName:body.fileName,mimeType:body.mimeType,size:body.size,sha256:body.sha256,createdAt:new Date().toISOString(),usageCount:0};}await load();if(last)setSelectedId(last.id);onToast(list.length>1?`${list.length} 个文件已加入媒体库`:"文件已加入媒体库");}catch(reason){setError(reason instanceof Error?reason.message:"上传失败");}finally{setBusy(false);setDragging(false);}}
  async function remove(asset:MediaAsset){if(asset.usageCount>0){setError("该文件已被消息使用，不能删除");return;}if(!window.confirm(`从媒体库删除“${asset.fileName}”？`))return;setBusy(true);const result=await authorizedFetch(`/api/v1/media/${asset.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);setBusy(false);if(!result.response.ok){setError(result.response.status===409?"该文件已被消息使用，不能删除":`删除失败（HTTP ${result.response.status}）`);return;}if(selectedId===asset.id)setSelectedId("");await load();onToast("文件已从媒体库删除");}
  return <div className="modal-backdrop media-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="media-dialog" role="dialog" aria-modal="true" aria-labelledby="media-dialog-title"><header><div><span className="login-logo"><Paperclip size={21}/></span><span><h2 id="media-dialog-title">媒体与附件</h2><p>上传一次，之后可在该 WhatsApp 账号的会话中复用。</p></span></div><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button></header><div className={`media-dropzone ${dragging?"dragging":""}`} onDragEnter={event=>{event.preventDefault();setDragging(true)}} onDragOver={event=>event.preventDefault()} onDragLeave={event=>{if(event.currentTarget===event.target)setDragging(false)}} onDrop={event=>{event.preventDefault();void upload(event.dataTransfer.files)}} onClick={()=>inputRef.current?.click()} role="button" tabIndex={0} onKeyDown={event=>{if(event.key==="Enter"||event.key===" ")inputRef.current?.click();}}><UploadCloud size={30}/><b>{busy?"正在上传…":"拖拽文件到这里，或点击选择"}</b><span>图片、MP4、OGG、MP3、PDF、ZIP；单文件最大 64 MB</span><input ref={inputRef} type="file" multiple accept="image/jpeg,image/png,image/webp,video/mp4,audio/ogg,audio/mpeg,application/pdf,application/zip" onChange={event=>{if(event.target.files)void upload(event.target.files);event.currentTarget.value="";}}/></div><div className="media-library-head"><div><b>媒体库</b><span>{assets.length} 个文件</span></div><label><Search size={14}/><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="搜索文件名"/></label></div><div className="media-filters">{[["all","全部"],["image","图片"],["video","视频"],["audio","音频"],["document","文档"]].map(([value,label])=><button key={value} className={filter===value?"active":""} onClick={()=>setFilter(value)}>{label}</button>)}</div><div className="media-grid">{visible.length?visible.map(asset=><button key={asset.id} className={`media-item ${selectedId===asset.id?"selected":""}`} onClick={()=>setSelectedId(asset.id)}><span className={`media-kind ${mediaKind(asset.mimeType)}`}><FileText size={22}/></span><span><b title={asset.fileName}>{asset.fileName}</b><small>{formatBytes(asset.size)} · {asset.usageCount?`已使用 ${asset.usageCount} 次`:"未使用"}</small></span><i role="button" tabIndex={0} aria-label={`删除 ${asset.fileName}`} onClick={event=>{event.stopPropagation();void remove(asset)}} onKeyDown={event=>{if(event.key==="Enter"){event.stopPropagation();void remove(asset);}}}><Trash2 size={14}/></i></button>):<div className="media-empty"><FileText size={28}/><b>媒体库中暂无匹配文件</b><span>可从上方拖拽上传</span></div>}</div>{error&&<span className="login-error media-error">{error}</span>}<footer><label>附件说明（可选）<input value={caption} onChange={event=>setCaption(event.target.value)} maxLength={65536} placeholder="随附件一起发送的文字"/></label><button className="secondary-action" onClick={onClose} disabled={busy}>取消</button><button className="primary-action" disabled={!selected||busy} onClick={()=>selected&&void onSend(selected,caption.trim())}>发送所选附件</button></footer></section></div>;
}

function mapMediaAsset(item:Record<string,unknown>):MediaAsset{return{id:String(item.id),fileName:String(item.file_name??"未命名文件"),mimeType:String(item.mime_type??"application/octet-stream"),size:Number(item.byte_size??0),sha256:String(item.sha256??""),createdAt:String(item.created_at??""),usageCount:Number(item.usage_count??0)};}
function mediaKind(mime:string){return mime.startsWith("image/")?"image":mime.startsWith("video/")?"video":mime.startsWith("audio/")?"audio":"document";}

function mapConversation(item:Record<string,unknown>,index:number):Conversation {const name=String(item.display_name??item.phone_e164??"未知联系人");return{id:String(item.id),name,initials:name.slice(0,2).toUpperCase(),color:COLORS[index%COLORS.length],account:String(item.account_name??"未知账号"),accountId:String(item.account_id),phone:String(item.phone_e164??""),preview:String(item.last_message??kindText(String(item.last_message_kind??""))),time:item.last_message_at?formatTime(new Date(String(item.last_message_at))):"",unread:Number(item.unread_count??0),accountStatus:String(item.account_status??"offline"),assignedUserId:item.assigned_user_id?String(item.assigned_user_id):null,favorite:Boolean(item.favorite),conversationStatus:String(item.status??"open")};}
function mapMessage(item:Record<string,unknown>):ChatMessage {const kind=String(item.kind??"text"),mediaId=String(item.media_id??"");return{id:String(item.id),direction:item.direction as "in"|"out",kind,text:String(item.text_content??(mediaId?"":kindText(kind))),time:formatTime(new Date(String(item.occurred_at))),status:item.status as ChatMessage["status"],attachment:item.file_name&&mediaId?{id:mediaId,name:String(item.file_name),mime:String(item.mime_type??"文件"),size:formatBytes(Number(item.byte_size??0))}:undefined};}
function kindText(kind:string){return({audio:"[语音消息]",image:"[图片]",video:"[视频]",document:"[文档]",location:"[位置]",contact:"[联系人名片]"} as Record<string,string>)[kind]??"暂无消息";}
function statusText(status:string){return({online:"在线",pairing:"等待配对",offline:"离线",logged_out:"已退出",error:"异常"} as Record<string,string>)[status]??status;}
function formatTime(date:Date){return Number.isNaN(date.getTime())?"":date.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"});}
function formatBytes(size:number){if(size<1024)return`${size} B`;if(size<1048576)return`${(size/1024).toFixed(1)} KB`;return`${(size/1048576).toFixed(1)} MB`;}
function tokenSubject(token:string){try{return String(JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).sub??"");}catch{return"";}}
function tokenRole(token:string){try{return String(JSON.parse(atob(token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role??"");}catch{return"";}}
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

function MessageMedia({attachment,token,onToken,onReady}:{attachment:{id:string;name:string;size:string;mime:string};token:string;onToken:(token:string)=>void;onReady:()=>void}){
  const [url,setUrl]=useState("");const [error,setError]=useState("");
  useEffect(()=>{const controller=new AbortController();let objectUrl="";void (async()=>{try{const result=await authorizedFetch(`/api/v1/media/${attachment.id}`,token,{signal:controller.signal});if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(`HTTP ${result.response.status}`);objectUrl=URL.createObjectURL(await result.response.blob());setUrl(objectUrl);setError("");}catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:"媒体加载失败");}})();return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};},[attachment.id,token,onToken]);
  if(error)return <div className="message-media message-media-error">媒体加载失败 · {error}</div>;if(!url)return <div className="message-media message-media-loading">正在加载媒体…</div>;
  if(attachment.mime.startsWith("image/"))return <div className="message-media"><button className="message-media-preview" onClick={()=>window.open(url,"_blank","noopener,noreferrer")} aria-label={`查看图片 ${attachment.name}`}><Image src={url} alt={attachment.name} width={440} height={440} unoptimized onLoad={onReady}/></button></div>;
  if(attachment.mime.startsWith("video/"))return <div className="message-media"><video src={url} controls preload="metadata" aria-label={attachment.name} onLoadedMetadata={onReady}/></div>;
  if(attachment.mime.startsWith("audio/"))return <div className="message-media"><audio src={url} controls preload="metadata" aria-label={attachment.name} onLoadedMetadata={onReady}/></div>;
  return <button className="attachment-card" onClick={()=>{const link=document.createElement("a");link.href=url;link.download=attachment.name;link.click();}}><span><FileText size={20}/></span><span><b>{attachment.name}</b><small>{attachment.mime} · {attachment.size}</small></span></button>;
}

function AgentManagement({token,role,onToken,onToast}:{token:string;role:string;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [agents,setAgents]=useState<ManagedAgent[]>([]);const [loading,setLoading]=useState(true);const [error,setError]=useState("");const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);
  const load=useCallback(async(quiet=false)=>{if(!token)return;if(!quiet)setLoading(true);try{const result=await authorizedFetch("/api/v1/agents",token);if(result.token!==token)onToken(result.token);if(!result.response.ok)throw new Error(result.response.status===403?"当前账号无权查看 Agent":"Agent 列表加载失败");const body=await result.response.json() as {data:ManagedAgent[]};setAgents(body.data);setError("");}catch(reason){setError(reason instanceof Error?reason.message:"Agent 列表加载失败");}finally{if(!quiet)setLoading(false);}},[token,onToken]);
  useEffect(()=>{const initial=window.setTimeout(()=>void load(),0);const timer=window.setInterval(()=>void load(true),5000);return()=>{window.clearTimeout(initial);window.clearInterval(timer);};},[load]);
  async function createAgent(){const name=window.prompt("输入 Agent 设备名称","Windows Agent");if(!name?.trim())return;const result=await authorizedFetch("/api/v1/agents/enrollment",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:name.trim()})});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`创建失败（HTTP ${result.response.status}）`);return;}const body=await result.response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});void load(true);}
  async function renameAgent(agent:ManagedAgent){const name=window.prompt("修改 Agent 名称",agent.name);if(!name?.trim()||name.trim()===agent.name)return;await mutate(agent.id,{name:name.trim()},"Agent 名称已更新");}
  async function revokeAgent(agent:ManagedAgent){if(!window.confirm(`撤销「${agent.name}」后，该设备必须重新注册才能连接。确定继续？`))return;await mutate(agent.id,{revoke:true},"Agent 已撤销");}
  async function deleteAgent(agent:ManagedAgent){if(!window.confirm(`永久删除「${agent.name}」的中心登记？账号历史消息仍会保留。`))return;const result=await authorizedFetch(`/api/v1/agents/${agent.id}`,token,{method:"DELETE"});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`删除失败（HTTP ${result.response.status}）`);return;}onToast("Agent 登记已删除");void load(true);}
  async function mutate(id:string,body:Record<string,unknown>,success:string){const result=await authorizedFetch(`/api/v1/agents/${id}`,token,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(result.token!==token)onToken(result.token);if(!result.response.ok){onToast(`操作失败（HTTP ${result.response.status}）`);return;}onToast(success);void load(true);}
  async function copyCode(){if(!enrollment)return;try{await navigator.clipboard.writeText(enrollment.code);onToast("注册码已复制");}catch{onToast("复制失败，请手动复制");}}
  return <section className="management-panel"><header className="management-head"><div><span className="eyebrow">设备与连接</span><h1>Agent 管理</h1><p>查看所有已注册 Windows Agent、连接状态和所管理的 WhatsApp 账号。</p></div><div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={15}/>刷新</button>{role==="admin"&&<button className="primary-action" onClick={()=>void createAgent()}><Plus size={15}/>注册新 Agent</button>}</div></header>
    {enrollment&&<div className="management-enrollment"><span><b>一次性注册码</b><small>有效期至 {new Date(enrollment.expiresAt).toLocaleString("zh-CN")}</small></span><code>{enrollment.code}</code><button onClick={()=>void copyCode()}>复制</button><button onClick={()=>setEnrollment(null)} aria-label="关闭"><X size={15}/></button></div>}
    <div className="management-summary"><SummaryCard label="全部 Agent" value={agents.length}/><SummaryCard label="当前在线" value={agents.filter(agentIsOnline).length}/><SummaryCard label="已绑定账号" value={agents.reduce((sum,agent)=>sum+agent.accounts.length,0)}/><SummaryCard label="在线账号" value={agents.filter(agentIsOnline).flatMap(agent=>agent.accounts).filter(account=>account.status==="online").length}/></div>
    {loading?<EmptyState title="正在读取 Agent" text="请稍候…"/>:error?<EmptyState title="Agent 数据加载失败" text={error}/>:agents.length?<div className="agent-grid">{agents.map(agent=>{const online=agentIsOnline(agent),effectiveStatus=online?"online":agent.status==="revoked"?"revoked":agent.status==="pending"?"pending":"offline";return <article className="agent-card" key={agent.id}><div className="agent-card-head"><span className={`agent-device ${online?"online":""}`}><MonitorSmartphone size={20}/></span><span><b>{agent.name}</b><small>{agent.platform||"平台待上报"} · v{agent.version||"未知"}</small></span><em className={`agent-badge ${effectiveStatus}`}>{agentStatusText(effectiveStatus)}</em></div><dl><div><dt>最后心跳</dt><dd>{agent.last_seen_at?formatLastSeen(agent.last_seen_at):"从未连接"}</dd></div><div><dt>确认游标</dt><dd>{agent.last_acked_cursor??0}</dd></div><div><dt>协议版本</dt><dd>{agent.protocol_version??"待协商"}</dd></div><div><dt>注册时间</dt><dd>{new Date(agent.created_at).toLocaleDateString("zh-CN")}</dd></div></dl>{!online&&agent.status!=="pending"&&agent.status!=="revoked"&&<div className="agent-timeout-note"><WifiOff size={13}/>超过 45 秒未收到心跳，已判定离线</div>}<div className="agent-accounts"><h3>WhatsApp 账号 <span>{agent.accounts.length}</span></h3>{agent.accounts.length?agent.accounts.map(account=>{const accountOnline=online&&account.status==="online";return <div key={account.id}><i className={`status-dot ${accountOnline?"online":""}`}/><span><b>{account.display_name}</b><small>{account.phone_e164||(online?account.status_reason:"Agent 已离线")||statusText(account.status)}</small></span><em>{accountOnline?"在线":"离线"}</em></div>}):<p>此 Agent 尚未绑定账号</p>}</div>{role==="admin"?<footer><button onClick={()=>void renameAgent(agent)}>编辑名称</button>{agent.status!=="revoked"&&<button onClick={()=>void revokeAgent(agent)}>撤销凭据</button>}<button className="danger-text" onClick={()=>void deleteAgent(agent)}><Trash2 size={13}/>移除 Agent</button></footer>:<p className="agent-permission-note">当前账号仅可查看；管理员登录后可移除 Agent。</p>}</article>})}</div>:<EmptyState title="尚未注册 Agent" text="点击右上角“注册新 Agent”生成一次性注册码"/>}
  </section>;
}

function SummaryCard({label,value}:{label:string;value:number}){return <div><span>{label}</span><b>{value}</b></div>;}
function agentStatusText(status:string){return({pending:"待注册",online:"在线",offline:"离线",revoked:"已撤销"} as Record<string,string>)[status]??status;}
function agentIsOnline(agent:ManagedAgent){if(agent.status!=="online"||!agent.last_seen_at)return false;return Date.now()-new Date(agent.last_seen_at).getTime()<45_000;}
function formatLastSeen(value:string){const date=new Date(value),seconds=Math.max(0,Math.floor((Date.now()-date.getTime())/1000));if(seconds<60)return`${seconds} 秒前`;if(seconds<3600)return`${Math.floor(seconds/60)} 分钟前`;return date.toLocaleString("zh-CN");}
function HelpPanel({onInbox,onAgents}:{onInbox:()=>void;onAgents:()=>void}){return <section className="management-panel help-panel"><header className="management-head"><div><span className="eyebrow">使用帮助</span><h1>RelayDesk 操作入口</h1><p>所有导航按钮现在都会进入对应的真实功能。</p></div></header><div className="help-grid"><button onClick={onInbox}><MessageCircle size={21}/><span><b>消息中心</b><small>查看 Agent 同步到 PostgreSQL 的真实会话和消息</small></span></button><button onClick={onAgents}><MonitorSmartphone size={21}/><span><b>Agent 管理</b><small>查看注册设备、版本、在线状态及绑定账号</small></span></button><div><ShieldCheck size={21}/><span><b>中心设置</b><small>点击左下角齿轮生成一次性注册码或退出登录</small></span></div><div><Wifi size={21}/><span><b>数据同步</b><small>Windows Agent 在线后，消息会自动进入中心工作台</small></span></div></div></section>;}

function NewConversationDialog({accounts,token,onToken,onClose,onCreated}:{accounts:Account[];token:string;onToken:(token:string)=>void;onClose:()=>void;onCreated:(conversationId:string,accountId:string,accessToken:string)=>Promise<void>}){
  const preferred=accounts.find(account=>account.status==="online")?.id??accounts[0]?.id??"";const [accountId,setAccountId]=useState(preferred);const [phone,setPhone]=useState("");const [displayName,setDisplayName]=useState("");const [firstMessage,setFirstMessage]=useState("");const [busy,setBusy]=useState(false);const [error,setError]=useState("");const account=accounts.find(item=>item.id===accountId);
  async function submit(){if(!accountId||!phone.trim()||!firstMessage.trim())return;setBusy(true);setError("");try{const result=await authorizedFetch("/api/v1/conversations",token,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId,phone,displayName:displayName.trim()||undefined,firstMessage:firstMessage.trim(),clientMessageId:crypto.randomUUID()})});if(result.token!==token)onToken(result.token);const body=await result.response.json() as {conversationId?:string;error?:string;details?:{fieldErrors?:Record<string,string[]>}};if(!result.response.ok||!body.conversationId){const detail=body.details?.fieldErrors?Object.values(body.details.fieldErrors).flat()[0]:undefined;throw new Error(detail||({account_not_found:"发送账号不存在或已解绑",invalid_request:"请检查号码和消息内容"} as Record<string,string>)[body.error??""]||`创建失败（HTTP ${result.response.status}）`);}await onCreated(body.conversationId,accountId,result.token);}catch(reason){setError(reason instanceof Error?reason.message:"新建会话失败");}finally{setBusy(false);}}
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}><section className="login-dialog new-conversation-dialog" role="dialog" aria-modal="true" aria-labelledby="new-conversation-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><MessageCircle size={21}/></span><h2 id="new-conversation-title">新建 WhatsApp 会话</h2><p>仅向单个号码发送，不提供群发。号码必须包含国家或地区代码。</p><label>发送账号<select value={accountId} onChange={event=>setAccountId(event.target.value)} disabled={busy||!accounts.length}>{accounts.length?accounts.map(item=><option value={item.id} key={item.id}>{item.name}（{statusText(item.status)}）</option>):<option value="">暂无已绑定账号</option>}</select></label><div className="conversation-form-grid"><label>WhatsApp 号码<input value={phone} onChange={event=>setPhone(event.target.value)} placeholder="例如：+8613800138000" inputMode="tel" autoFocus/></label><label>联系人名称（可选）<input value={displayName} onChange={event=>setDisplayName(event.target.value)} maxLength={80} placeholder="客户名称"/></label></div><label>首条消息<textarea value={firstMessage} onChange={event=>setFirstMessage(event.target.value)} maxLength={65536} placeholder="输入要发送的消息" onKeyDown={event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey))void submit();}}/></label>{account&&account.status!=="online"&&<span className="new-conversation-warning"><Clock3 size={13}/>当前账号离线，消息会先进入持久队列。</span>}{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!accountId||!phone.trim()||!firstMessage.trim()} onClick={()=>void submit()}>{busy?"正在创建…":"创建会话并发送"}</button><small className="dialog-hint">Ctrl / Cmd + Enter 快速提交</small></section></div>;
}

function LoginDialog({connected,token,canClose,onClose,onLogin,onLogout}:{connected:boolean;token:string;canClose:boolean;onClose:()=>void;onLogin:(token:string,user:User)=>void;onLogout:()=>void}){
  const [email,setEmail]=useState("");const [password,setPassword]=useState("");const [error,setError]=useState("");const [busy,setBusy]=useState(false);const [agentName,setAgentName]=useState("Windows Agent");const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);const [copied,setCopied]=useState(false);
  async function submit(){setBusy(true);setError("");try{const response=await fetch(`${API_URL}/api/v1/auth/login`,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});const body=await response.json() as {accessToken?:string;user?:User;error?:string};if(!response.ok||!body.accessToken||!body.user)throw new Error(response.status===401?"邮箱或密码错误":`登录失败（HTTP ${response.status}）`);onLogin(body.accessToken,body.user);}catch(reason){setError(reason instanceof Error?reason.message:"登录失败");}finally{setBusy(false);}}
  async function createEnrollment(){setBusy(true);setError("");setEnrollment(null);try{const response=await fetch(`${API_URL}/api/v1/agents/enrollment`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:agentName.trim()||"Windows Agent"})});if(response.status===401)throw new Error("登录已过期");if(response.status===403)throw new Error("只有管理员可以生成注册码");if(!response.ok)throw new Error(`注册码生成失败（HTTP ${response.status}）`);const body=await response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});}catch(reason){setError(reason instanceof Error?reason.message:"注册码生成失败");}finally{setBusy(false);}}
  async function copyEnrollment(){if(!enrollment)return;try{await navigator.clipboard.writeText(enrollment.code);setCopied(true);window.setTimeout(()=>setCopied(false),1500);}catch{setError("剪贴板不可用，请手动复制");}}
  return <div className="modal-backdrop" role="presentation" onMouseDown={event=>{if(canClose&&event.target===event.currentTarget)onClose();}}><section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">{canClose&&<button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button>}<span className="login-logo"><ShieldCheck size={21}/></span><h2 id="login-title">{connected?"中心设置":"登录 RelayDesk"}</h2><p>{connected?"生成 Agent 一次性注册码，或退出当前坐席。":"仅限获授权的 GeekMT 团队成员。请使用管理员发放的 RelayDesk 坐席凭据。"}</p>{connected?<><div className="center-endpoint"><span>中心地址</span><strong>{API_URL||"当前站点"}</strong></div><label>Agent 设备名称<input value={agentName} onChange={event=>setAgentName(event.target.value)} maxLength={80}/></label><button className="login-submit" disabled={busy} onClick={()=>void createEnrollment()}>{busy?"正在生成...":"生成一次性注册码"}</button>{enrollment&&<div className="enrollment-result"><span>一次性注册码</span><code>{enrollment.code}</code><small>有效期至 {new Date(enrollment.expiresAt).toLocaleString("zh-CN")}</small><button onClick={()=>void copyEnrollment()}>{copied?"已复制":"复制注册码"}</button></div>}{error&&<span className="login-error">{error}</span>}<button className="login-submit danger" onClick={onLogout}>退出中心平台</button></>:<><div className="login-safety"><ShieldCheck size={15}/><span>不要输入 WhatsApp / Meta 密码、短信验证码或两步验证 PIN。</span></div><label>RelayDesk 邮箱<input value={email} onChange={event=>setEmail(event.target.value)} autoComplete="username" autoFocus/></label><label>RelayDesk 密码<input type="password" value={password} onChange={event=>setPassword(event.target.value)} onKeyDown={event=>{if(event.key==="Enter")void submit();}} autoComplete="current-password"/></label>{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy||!email||!password} onClick={()=>void submit()}>{busy?"正在验证...":"登录私有工作台"}</button><small className="login-affiliation">由 GeekMT 运营 · 与 Meta 或 WhatsApp 无隶属、赞助或背书关系</small></>}</section></div>;
}
