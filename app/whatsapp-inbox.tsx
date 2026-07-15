"use client";

import {
  Archive, Bookmark, Check, CheckCheck, ChevronDown, CircleHelp, Clock3,
  File, FileText, Inbox, Info, Link2, Menu, MessageCircle, Mic,
  MoreHorizontal, Paperclip, Phone, Plus, Search, Send, Settings,
  ShieldCheck, Smile, Sparkles, Star, Tag, UserPlus, Users, Wifi,
  WifiOff, X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_RELAY_API_URL ?? "";

type Conversation = {
  id: string; name: string; initials: string; color: string; account: string; accountId?: string;
  phone: string; preview: string; time: string; unread: number;
  status: "online" | "offline"; assigned: string; labels: string[]; favorite?: boolean;
};

type ChatMessage = {
  id: string; direction: "in" | "out"; text: string; time: string;
  status?: "queued" | "sent" | "delivered" | "read";
  attachment?: { name: string; size: string };
};

const conversations: Conversation[] = [
  { id: "pharah", name: "Pharah House", initials: "PH", color: "#6b4f3a", account: "新加坡销售", phone: "+65 8123 8890", preview: "好的，我们确认一下交付时间 👍", time: "12:42", unread: 2, status: "online", assigned: "我", labels: ["高意向", "样品"], favorite: true },
  { id: "leonard", name: "Leonard Kayle", initials: "LK", color: "#305f72", account: "美国售后", phone: "+1 415 555 0188", preview: "已经收到，谢谢你们的帮助", time: "12:31", unread: 1, status: "online", assigned: "陈思", labels: ["售后"] },
  { id: "leslie", name: "Leslie Winkle", initials: "LW", color: "#9b5f72", account: "新加坡销售", phone: "+44 7700 900816", preview: "请把最新的报价单发给我", time: "11:58", unread: 0, status: "offline", assigned: "未分配", labels: ["报价"] },
  { id: "richard", name: "Richard Hammon", initials: "RH", color: "#946b36", account: "美国售后", phone: "+1 202 555 0137", preview: "我们可以按这个计划继续", time: "11:09", unread: 6, status: "online", assigned: "我", labels: ["进行中"] },
  { id: "rob", name: "Rob Stark", initials: "RS", color: "#477a62", account: "新加坡销售", phone: "+61 412 345 678", preview: "语音消息 · 0:23", time: "09:16", unread: 0, status: "online", assigned: "林晓", labels: ["VIP"] },
  { id: "rick", name: "Rick Sanchez", initials: "RS", color: "#3a708b", account: "美国售后", phone: "+1 212 555 0196", preview: "我完全同意这个方案", time: "09:12", unread: 1, status: "offline", assigned: "未分配", labels: ["续费"] },
  { id: "howard", name: "Howard Evans", initials: "HE", color: "#705b86", account: "新加坡销售", phone: "+86 138 0013 8000", preview: "很好，我正在查看文件", time: "昨天", unread: 0, status: "online", assigned: "我", labels: ["合作伙伴"] },
];

const initialMessages: Record<string, ChatMessage[]> = {
  pharah: [
    { id: "m1", direction: "in", text: "我们需要确认产品在各种情况下都能正常工作，并保证消息不会因为网络波动丢失。", time: "10:15" },
    { id: "m2", direction: "out", text: "文件和说明已经整理好，请查收。我们也加入了断网重连与消息校验机制。", time: "10:17", status: "read", attachment: { name: "交付方案_v3.pdf", size: "2.4 MB" } },
    { id: "m3", direction: "in", text: "谢谢，我们正在检查 👍", time: "10:21" },
    { id: "m4", direction: "out", text: "没问题。如果需要调整，我们会在同一个会话里同步最新版本。", time: "10:23", status: "delivered" },
  ],
};

const navItems = [MessageCircle, Users, Send, Star, Clock3, Archive];

export function WhatsAppInbox() {
  const [conversationData, setConversationData] = useState(conversations);
  const [activeId, setActiveId] = useState("pharah");
  const [filter, setFilter] = useState("全部会话");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(initialMessages);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [authOpen, setAuthOpen] = useState(false);

  const active = conversationData.find((item) => item.id === activeId) ?? conversationData[0] ?? conversations[0];
  const visible = useMemo(() => conversationData.filter((item) => {
    const matchesText = `${item.name} ${item.preview} ${item.phone}`.toLowerCase().includes(query.toLowerCase());
    const matchesFilter = filter === "全部会话" || (filter === "分配给我" && item.assigned === "我") || (filter === "未分配" && item.assigned === "未分配") || (filter === "收藏" && item.favorite);
    return matchesText && matchesFilter;
  }), [conversationData, filter, query]);
  const currentMessages = messages[active.id] ?? [{ id: `${active.id}-first`, direction: "in" as const, text: active.preview, time: active.time }];

  useEffect(() => {
    const token = window.sessionStorage.getItem("relayAccessToken") ?? "";
    if (!token) return;
    const timer = window.setTimeout(() => {
      setApiToken(token);
      if (API_URL) void loadConversations(token);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!apiToken || !API_URL || !active.accountId) return;
    void fetch(`${API_URL}/api/v1/conversations/${active.id}/messages`, { headers:{ authorization:`Bearer ${apiToken}` } }).then(async(response)=>{
      if(!response.ok)throw new Error("消息加载失败");const body=await response.json() as {data:Array<Record<string,unknown>>};
      setMessages((all)=>({...all,[active.id]:body.data.map((item)=>({id:String(item.id),direction:item.direction as "in"|"out",text:String(item.text_content??(item.kind==="audio"?"语音消息":item.kind==="document"?"文档消息":"媒体消息")),time:new Date(String(item.occurred_at)).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}),status:item.status as ChatMessage["status"]}))}));
    }).catch(()=>setToast("无法加载中心消息，请检查 API 连接"));
  }, [active.id, active.accountId, apiToken]);

  async function loadConversations(token:string) {
    try {
      const response=await fetch(`${API_URL}/api/v1/conversations?limit=100`,{headers:{authorization:`Bearer ${token}`}});if(!response.ok)throw new Error("unauthorized");const body=await response.json() as {data:Array<Record<string,unknown>>};
      const mapped:Conversation[]=body.data.map((item,index)=>{const name=String(item.display_name??item.phone_e164??"未知联系人");return {id:String(item.id),name,initials:name.slice(0,2).toUpperCase(),color:["#6b4f3a","#305f72","#9b5f72","#477a62"][index%4],account:String(item.account_name),accountId:String(item.account_id),phone:String(item.phone_e164??""),preview:String(item.last_message??item.last_message_kind??"暂无消息"),time:item.last_message_at?new Date(String(item.last_message_at)).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}):"",unread:Number(item.unread_count??0),status:item.account_status==="online"?"online":"offline",assigned:item.assigned_user_id?"已分配":"未分配",labels:[]};});
      setConversationData(mapped);if(mapped.length)setActiveId(mapped[0].id);
    } catch { window.sessionStorage.removeItem("relayAccessToken");setApiToken("");setAuthOpen(true); }
  }

  async function sendMessage() {
    const text = draft.trim();
    if (!text) return;
    setMessages((all) => ({ ...all, [active.id]: [...currentMessages, {
      id: crypto.randomUUID(), direction: "out", text,
      time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
      status: active.status === "online" ? "sent" : "queued",
    }] }));
    setDraft("");
    setToast(active.status === "online" ? "消息已进入发送队列" : "账号离线，消息已安全排队");
    window.setTimeout(() => setToast(""), 2400);
    if(apiToken&&API_URL&&active.accountId){
      try{const response=await fetch(`${API_URL}/api/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${apiToken}`,"content-type":"application/json"},body:JSON.stringify({accountId:active.accountId,conversationId:active.id,clientMessageId:crypto.randomUUID(),type:"text",text})});if(!response.ok)throw new Error("发送失败");}
      catch{setToast("消息未能进入中心队列，请检查连接后重试");}
    }
  }

  return (
    <main className="relay-shell">
      {toast && <div className="toast"><Check size={15} />{toast}</div>}
      <nav className="rail" aria-label="全局导航">
        <button className="brand-mark" aria-label="RelayDesk"><Sparkles size={19} /></button>
        <div className="rail-nav">{navItems.map((Icon, index) => <button key={index} className={index === 0 ? "rail-button active" : "rail-button"} aria-label={["消息", "联系人", "发送", "收藏", "历史", "归档"][index]}><Icon size={18} /></button>)}</div>
        <div className="rail-bottom"><button className="rail-button" aria-label="帮助"><CircleHelp size={18} /></button><button className="rail-button" onClick={()=>setAuthOpen(true)} aria-label="设置与 Agent 注册"><Settings size={18} /></button><button className="profile-button" onClick={()=>setAuthOpen(true)} aria-label="登录与账户"><span className="avatar small coral">林</span></button></div>
      </nav>

      <aside className={`filters ${sidebarOpen ? "mobile-open" : ""}`}>
        <div className="mobile-filter-head"><b>收件箱</b><button onClick={() => setSidebarOpen(false)} aria-label="关闭筛选"><X size={18}/></button></div>
        <div className="workspace-title"><div><span className="eyebrow">工作空间</span><h1>消息中心</h1></div><button aria-label="新建"><Plus size={18}/></button></div>
        <button className="account-switcher"><span className="wa-dot"><Phone size={13}/></span><span><b>全部 WhatsApp 账号</b><small>2 在线 · 1 离线</small></span><ChevronDown size={15}/></button>
        <section><p className="section-label">收件箱</p>
          {[{label:"全部会话", icon:Inbox, count:30},{label:"分配给我", icon:Users, count:11},{label:"未分配", icon:UserPlus, count:5},{label:"收藏", icon:Star, count:9}].map(({label, icon:Icon, count}) => <button key={label} onClick={() => {setFilter(label); setSidebarOpen(false)}} className={filter === label ? "filter-row selected" : "filter-row"}><span><Icon size={15}/>{label}</span><em>{count}</em></button>)}
        </section>
        <section><p className="section-label">状态</p><button className="filter-row"><span><Clock3 size={15}/>等待回复</span><em>8</em></button><button className="filter-row"><span><Check size={15}/>已关闭</span><em>145</em></button><button className="filter-row"><span><Archive size={15}/>已归档</span><em>32</em></button></section>
        <section className="accounts-block"><p className="section-label">账号连接</p>
          <AccountStatus initials="SG" color="green" name="新加坡销售" detail="已连接 · 刚刚同步" online />
          <AccountStatus initials="US" color="blue" name="美国售后" detail="已连接 · 1 分钟前" online />
          <AccountStatus initials="EU" color="gray" name="欧洲渠道" detail="等待 Agent" />
        </section>
      </aside>

      <section className="conversation-panel">
        <header className="conversation-head"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开筛选"><Menu size={18}/></button><div><h2>{filter}</h2><span>{visible.length} 个会话</span></div><button className="icon-button" aria-label="更多"><MoreHorizontal size={18}/></button></header>
        <label className="search-box"><Search size={15}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索会话、联系人或号码"/></label>
        <div className="conversation-list">{visible.map((item) => <button key={item.id} onClick={() => setActiveId(item.id)} className={item.id === activeId ? "conversation active" : "conversation"}>
          <span className="avatar" style={{background:item.color}}>{item.initials}<i className={`presence ${item.status}`}/></span>
          <span className="conversation-copy"><span className="conversation-line"><b>{item.name}</b><time>{item.time}</time></span><span className="conversation-line preview"><span>{item.preview}</span>{item.unread > 0 && <em>{item.unread}</em>}</span><small>{item.account} · {item.assigned}</small></span>
        </button>)}</div>
      </section>

      <section className="chat-panel">
        <header className="chat-head"><div className="chat-person"><span className="avatar" style={{background:active.color}}>{active.initials}</span><span><b>{active.name}</b><small><i className={`status-dot ${active.status === "online" ? "online" : ""}`}/>{active.status === "online" ? `${active.account} · 在线` : `${active.account} · Agent 离线`}</small></span></div><div className="chat-actions"><button className="assign-button"><UserPlus size={15}/> {active.assigned === "未分配" ? "认领" : active.assigned}</button><button className="icon-button" aria-label="收藏"><Bookmark size={17}/></button><button onClick={() => setDetailsOpen(!detailsOpen)} className="icon-button" aria-label="联系人详情"><Info size={17}/></button></div></header>
        {active.status === "offline" && <div className="offline-banner"><WifiOff size={15}/><span>该账号暂时离线。新消息会持久化排队，在 Agent 恢复后按顺序发送。</span></div>}
        <div className="messages" aria-live="polite"><div className="day-separator"><span>今天</span></div>{currentMessages.map((message) => <article key={message.id} className={`message-row ${message.direction}`}>
          {message.direction === "in" && <span className="avatar message-avatar" style={{background:active.color}}>{active.initials}</span>}
          <div className="message-bubble"><p>{message.text}</p>{message.attachment && <button className="attachment-card"><span><FileText size={20}/></span><span><b>{message.attachment.name}</b><small>PDF · {message.attachment.size}</small></span><Link2 size={15}/></button>}<footer><time>{message.time}</time>{message.direction === "out" && <MessageStatus status={message.status}/>}</footer></div>
        </article>)}</div>
        <div className="composer-wrap"><div className="composer-tools"><button aria-label="添加附件"><Paperclip size={17}/></button><button aria-label="快捷回复"><Sparkles size={17}/></button><span>回复给 {active.name}</span></div><div className="composer"><textarea value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => {if(e.key === "Enter" && !e.shiftKey){e.preventDefault(); sendMessage();}}} placeholder="输入消息，Enter 发送，Shift + Enter 换行"/><div className="composer-icons"><button aria-label="表情"><Smile size={18}/></button><button aria-label="录音"><Mic size={18}/></button><button onClick={sendMessage} className="send-button" aria-label="发送"><Send size={18}/></button></div></div><p className="delivery-hint">{active.status === "online" ? <><Wifi size={13}/>已连接 · 消息将立即发送</> : <><Clock3 size={13}/>离线队列已启用</>}</p></div>
      </section>

      {detailsOpen && <aside className="details-panel"><header><h3>联系人详情</h3><button onClick={() => setDetailsOpen(false)} className="icon-button" aria-label="关闭详情"><X size={17}/></button></header>
        <div className="contact-card"><span className="avatar large" style={{background:active.color}}>{active.initials}</span><h2>{active.name}</h2><p>{active.phone}</p><span className="contact-online"><i className={`status-dot ${active.status === "online" ? "online" : ""}`}/>{active.status === "online" ? "WhatsApp 在线" : "账号离线"}</span><div className="contact-buttons"><button><Phone size={16}/><span>拨号</span></button><button><FileText size={16}/><span>备注</span></button><button><MoreHorizontal size={16}/><span>更多</span></button></div></div>
        <div className="detail-section"><h4>会话信息</h4><dl><div><dt>负责坐席</dt><dd>{active.assigned}</dd></div><div><dt>接入账号</dt><dd>{active.account}</dd></div><div><dt>最近联系</dt><dd>刚刚</dd></div><div><dt>会话状态</dt><dd className="green-text">进行中</dd></div></dl></div>
        <div className="detail-section"><div className="detail-title"><h4>标签</h4><button><Plus size={14}/>添加</button></div><div className="tags">{active.labels.map((label) => <span key={label}><Tag size={12}/>{label}</span>)}</div></div>
        <div className="detail-section"><div className="detail-title"><h4>共享文件</h4><button>查看全部</button></div><div className="shared-file"><span><File size={18}/></span><span><b>交付方案_v3.pdf</b><small>今天 · 2.4 MB</small></span></div></div>
        <div className="security-note"><ShieldCheck size={16}/><span><b>可靠同步已启用</b><small>消息已持久化并通过幂等校验</small></span></div>
      </aside>}
      {authOpen && <LoginDialog connected={Boolean(apiToken)} token={apiToken} onClose={()=>setAuthOpen(false)} onLogin={(token)=>{window.sessionStorage.setItem("relayAccessToken",token);setApiToken(token);void loadConversations(token);}} onLogout={()=>{window.sessionStorage.removeItem("relayAccessToken");setApiToken("");setConversationData(conversations);setActiveId("pharah");setAuthOpen(false);}}/>}
    </main>
  );
}

function AccountStatus({ initials, color, name, detail, online = false }: { initials: string; color: string; name: string; detail: string; online?: boolean }) {
  return <div className={`account-status ${online ? "" : "muted"}`}><span className={`avatar tiny ${color}`}>{initials}</span><span><b>{name}</b><small><i className={`status-dot ${online ? "online" : ""}`}/>{detail}</small></span></div>;
}

function MessageStatus({ status }: { status?: ChatMessage["status"] }) {
  if (status === "queued") return <span className="message-state queued"><Clock3 size={12}/>排队中</span>;
  if (status === "read") return <span className="message-state read"><CheckCheck size={13}/>已读</span>;
  if (status === "delivered") return <span className="message-state"><CheckCheck size={13}/>已送达</span>;
  return <span className="message-state"><Check size={13}/>已发送</span>;
}

function LoginDialog({connected,token,onClose,onLogin,onLogout}:{connected:boolean;token:string;onClose:()=>void;onLogin:(token:string)=>void;onLogout:()=>void}){
  const [email,setEmail]=useState("samlau0086@gmail.com");
  const [password,setPassword]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [agentName,setAgentName]=useState("家庭 Windows Agent");
  const [enrollment,setEnrollment]=useState<{code:string;expiresAt:string}|null>(null);
  const [copied,setCopied]=useState(false);
  async function submit(){if(!API_URL){setError("当前为本地界面预览；配置 NEXT_PUBLIC_RELAY_API_URL 后可登录中心平台。");return;}setBusy(true);setError("");try{const response=await fetch(`${API_URL}/api/v1/auth/login`,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify({email,password})});if(!response.ok)throw new Error("邮箱或密码错误");const body=await response.json() as {accessToken:string};onLogin(body.accessToken);}catch(reason){setError(reason instanceof Error?reason.message:"登录失败");}finally{setBusy(false);}}
  async function createEnrollment(){if(!API_URL||!token){setError("请先重新登录中心平台");return;}setBusy(true);setError("");setEnrollment(null);try{const response=await fetch(`${API_URL}/api/v1/agents/enrollment`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({name:agentName.trim()||"Windows Agent"})});if(response.status===401)throw new Error("登录已过期，请退出后重新登录");if(response.status===403)throw new Error("只有管理员可以生成 Agent 注册码");if(!response.ok)throw new Error("注册码生成失败，请检查中心 API");const body=await response.json() as {enrollmentCode:string;expiresAt:string};setEnrollment({code:body.enrollmentCode,expiresAt:body.expiresAt});}catch(reason){setError(reason instanceof Error?reason.message:"注册码生成失败");}finally{setBusy(false);}}
  async function copyEnrollment(){if(!enrollment)return;try{await navigator.clipboard.writeText(enrollment.code);setCopied(true);window.setTimeout(()=>setCopied(false),1500);}catch{setError("剪贴板不可用，请手动选择并复制注册码");}}
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event)=>{if(event.target===event.currentTarget)onClose();}}><section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title"><button className="login-close" onClick={onClose} aria-label="关闭"><X size={17}/></button><span className="login-logo"><ShieldCheck size={21}/></span><h2 id="login-title">{connected?"中心平台与 Agent 注册":"登录 RelayDesk"}</h2><p>{connected?"为 Windows Agent 生成一次性注册码，有效期为 15 分钟。":"使用管理员邀请的坐席账号登录。"}</p>{connected?<><div className="center-endpoint"><span>中心地址</span><strong>{API_URL}</strong></div><label>Agent 设备名称<input value={agentName} onChange={(event)=>setAgentName(event.target.value)} maxLength={80}/></label><button className="login-submit" disabled={busy} onClick={()=>void createEnrollment()}>{busy?"正在生成...":"生成一次性注册码"}</button>{enrollment&&<div className="enrollment-result"><span>一次性注册码</span><code>{enrollment.code}</code><small>有效期至 {new Date(enrollment.expiresAt).toLocaleString("zh-CN")}</small><button onClick={()=>void copyEnrollment()}>{copied?"已复制":"复制注册码"}</button></div>}{error&&<span className="login-error">{error}</span>}<button className="login-submit danger" onClick={onLogout}>退出中心平台</button></>:<><label>邮箱<input value={email} onChange={(event)=>setEmail(event.target.value)} autoComplete="username"/></label><label>密码<input type="password" value={password} onChange={(event)=>setPassword(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")void submit();}} autoComplete="current-password"/></label>{error&&<span className="login-error">{error}</span>}<button className="login-submit" disabled={busy} onClick={()=>void submit()}>{busy?"正在连接...":"登录并加载会话"}</button></>}</section></div>;
}
