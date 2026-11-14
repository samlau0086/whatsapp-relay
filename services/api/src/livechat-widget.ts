// 嵌入脚本在宿主网站请求 API；凭证不进入 iframe 或 URL。
export const livechatLoader=String.raw`(()=>{
const script=document.currentScript,channel=script&&script.dataset.channel;
if(!channel||!/^[a-f0-9-]{36}$/i.test(channel))return;
const base=new URL(script.src).origin,path=base+'/livechat/'+channel;
const key='relaydesk.livechat:'+base+':'+channel;
const registryKey=Symbol.for('relaydesk.livechat.instances'),registry=globalThis[registryKey]||(globalThis[registryKey]=new Set());
if(registry.has(key))return;registry.add(key);
let secret,started=false;try{secret=localStorage.getItem(key);started=localStorage.getItem(key+':started')==='1'}catch{}
let outbox={};try{const saved=JSON.parse(localStorage.getItem(key+':outbox')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))outbox=saved}catch{}
function saveOutbox(){try{localStorage.setItem(key+':outbox',JSON.stringify(outbox))}catch{}}
if(!secret||!/^[a-f0-9]{64}$/.test(secret)){secret=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');try{localStorage.setItem(key,secret)}catch{}}
async function api(action,data){
if(action==='reset'){secret=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');started=false;outbox={};saveOutbox();try{localStorage.setItem(key,secret);localStorage.removeItem(key+':started');localStorage.removeItem(key+':read')}catch{}return {ok:true}}
let url=path+'/'+action,options={credentials:'omit',headers:{authorization:'Bearer '+secret}};
if(action==='send'){if(!Object.hasOwn(outbox,data.clientMessageId)&&Object.keys(outbox).length>=30)throw Error('待重试消息过多，请先处理已有消息');outbox[data.clientMessageId]=data;saveOutbox();url=path+'/messages';options.method='POST';options.headers['content-type']='application/json';options.body=JSON.stringify(data)}
else if(action==='upload'){url=path+'/media';options.method='POST';const body=new FormData();body.append('file',data.file);options.body=body}
else if(action==='history'){url=path+'/messages'+(data&&data.before?'?before='+encodeURIComponent(data.before):data&&data.after?'?after='+encodeURIComponent(data.after):'')}
else if(action==='download'){if(!/^[a-f0-9-]{36}$/.test(data.id))throw Error('invalid_attachment');url=path+'/media/'+data.id}
else if(action!=='config')throw Error('invalid_action');
const response=await fetch(url,{...options,referrerPolicy:'origin',signal:AbortSignal.timeout(30000)});
if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(response.status===401&&started?'visitor_session_expired':body.error||'HTTP '+response.status)}
if(action==='send'||action==='history'){started=true;try{localStorage.setItem(key+':started','1')}catch{}}
if(action==='send'){delete outbox[data.clientMessageId];saveOutbox()}
if(action==='download')return {blob:await response.blob()};
const result=await response.json();
if(action==='history'){let changed=false;for(const message of result.data||[]){if(Object.hasOwn(outbox,message.client_message_id)){delete outbox[message.client_message_id];changed=true}}if(changed)saveOutbox()}
return result;
}
api('config').then(config=>{
const host=document.createElement('div');host.style.setProperty('all','initial','important');document.body.append(host);
const shadow=host.attachShadow({mode:'closed'}),frame=document.createElement('iframe');
frame.title=config.name+' 在线客服';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads allow-forms');frame.src=path+'/widget';
Object.assign(frame.style,{position:'fixed',bottom:'16px',border:'0',zIndex:'2147483647',background:'transparent',colorScheme:'light',display:'block'});
frame.style[config.position==='left'?'left':'right']='16px';let expanded=false;
function resize(){frame.style.width=expanded?Math.min(390,innerWidth-24)+'px':'72px';frame.style.height=expanded?Math.min(640,innerHeight-32)+'px':'72px';frame.style.bottom=innerHeight<500?'8px':'16px'}
resize();addEventListener('resize',resize);
const post=data=>frame.contentWindow.postMessage(data,base);
addEventListener('message',async event=>{
if(event.origin!==base||event.source!==frame.contentWindow||!event.data||event.data.namespace!=='relaydesk-livechat')return;
const m=event.data;
if(m.action==='ready'){let read='';try{read=localStorage.getItem(key+':read')||''}catch{}post({namespace:m.namespace,init:config,lastRead:read,outbox});return}
if(m.action==='expand'){expanded=!!m.open;resize();return}
if(m.action==='read'){try{localStorage.setItem(key+':read',String(m.id||''))}catch{}return}
if(!['send','upload','history','download','reset'].includes(m.action)||typeof m.requestId!=='string')return;
try{post({namespace:m.namespace,requestId:m.requestId,result:await api(m.action,m.data)})}catch(error){post({namespace:m.namespace,requestId:m.requestId,error:String(error.message||error)})}
});
shadow.append(frame);
}).catch(()=>registry.delete(key));
})();`;

export const livechatWidget=String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>在线客服</title><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;background:transparent;font:14px/1.5 system-ui,sans-serif;color:#202629;letter-spacing:0}button,input,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #0b7780;outline-offset:2px}button{border:0;background:none;color:inherit}#launcher{width:56px;height:56px;border-radius:50%;background:var(--theme,#146d73);color:white;position:absolute;bottom:8px;right:8px;box-shadow:0 3px 12px #0003;display:grid;place-items:center}#launcher:before{content:'';width:24px;height:18px;border:2px solid white;border-radius:5px}#launcher:after{content:'';position:absolute;top:35px;left:23px;width:6px;height:6px;border-left:2px solid white;transform:skewY(-35deg)}#badge{position:absolute;right:0;top:0;background:#d53d52;color:white;border-radius:12px;min-width:22px;font-size:12px;border:2px solid white}#panel{height:100%;display:flex;flex-direction:column;background:white;border:1px solid #dce2e3;border-radius:8px;overflow:hidden;box-shadow:0 2px 10px #0002}header{display:flex;align-items:center;padding:18px 16px;background:var(--theme,#146d73);color:white;gap:12px}header .avatar{width:38px;height:38px;flex-shrink:0;border:1px solid #ffffff80;border-radius:50%;display:grid;place-items:center;font-weight:600}header .title{flex:1;min-width:0}h1{font-size:16px;margin:0;overflow-wrap:anywhere}header small{font-size:12px;opacity:.9}header button{color:white;width:32px;height:32px;font-size:24px;flex-shrink:0}#timeline{flex:1;overflow:auto;padding:18px 14px;background:#f7f9fa;overscroll-behavior:contain}.welcome{background:#fff;border-left:3px solid var(--theme,#146d73);padding:12px;margin-bottom:20px;white-space:pre-wrap;overflow-wrap:anywhere}.message{margin:0 0 16px;display:flex;flex-direction:column;align-items:flex-start}.message.out{align-items:flex-end}.bubble{background:white;border:1px solid #e1e6e8;border-radius:8px;padding:10px 12px;max-width:90%;white-space:pre-wrap;overflow-wrap:anywhere}.out .bubble{background:var(--theme,#146d73);color:white;border:0}.message small{font-size:11px;color:#6a767d;margin-top:4px}.attachment{display:block;text-align:left;max-width:100%;overflow-wrap:anywhere;text-decoration:underline;color:inherit}.attachment img{max-width:100%;max-height:220px;display:block;border-radius:4px}#notice{font-size:12px;color:#a33142;padding:0 12px;background:#fff3f4}#identity{display:flex;gap:8px;padding:10px 12px 0}#identity input{width:50%;min-width:0;padding:6px;border:1px solid #dce2e3;border-radius:4px;font-size:12px}form{display:flex;align-items:flex-end;padding:12px;gap:6px;border-top:1px solid #e1e6e8}textarea{resize:none;flex:1;min-width:0;max-height:100px;height:64px;border:0;outline:none;padding:4px;background:white;color:#202629}form button{width:36px;height:36px;border-radius:4px;font-size:23px;flex-shrink:0}#send{background:var(--theme,#146d73);color:white}#older{display:block;font-size:12px;text-decoration:underline;margin:0 auto 14px;color:#526168}#footer{font-size:10px;color:#8a9397;text-align:center;padding:0 0 8px}#panel[hidden],#launcher[hidden],#badge[hidden],#older[hidden]{display:none}@media(max-height:460px){header{padding:8px 12px}#identity{display:none}#footer{display:none}textarea{height:40px}}
</style></head><body><button id="launcher" aria-label="打开在线客服"><span id="badge" hidden></span></button><section id="panel" role="dialog" aria-label="在线客服" hidden><header><div class="avatar">R</div><div class="title"><h1 id="name">在线客服</h1><small id="connection">欢迎与我们联系</small></div><button id="close" title="收起" aria-label="收起聊天">&#8722;</button></header><main id="timeline" aria-live="polite"><button id="older" hidden>更早的消息</button><div id="welcome" class="welcome"></div><div id="messages"></div></main><div id="notice" role="status"></div><button id="restart" hidden type="button">开始新会话</button><div id="identity"><input id="visitorName" maxlength="80" aria-label="姓名（可选）" placeholder="姓名（可选）"><input id="email" type="email" maxlength="254" aria-label="邮箱（可选）" placeholder="邮箱（可选）"></div><form id="form"><button id="attach" type="button" title="添加图片或文件" aria-label="添加附件">&#43;</button><textarea id="draft" maxlength="10000" aria-label="消息" placeholder="请输入消息..."></textarea><button id="send" title="发送" aria-label="发送">&#8593;</button><input hidden id="file" type="file" accept="image/png,image/jpeg,image/webp,application/pdf,text/plain"></form><div id="footer">RelayDesk</div></section><script>
(()=>{
const $=id=>document.getElementById(id),namespace='relaydesk-livechat',pending=new Map(),messages=new Map(),local=new Map();
let parentOrigin='',open=false,busy=false,uploading=false,initialized=false,lastRead='',latest='',first='',hasMore=false,syncing=false,active=false,cursor='';
const post=data=>parent.postMessage({namespace,...data},parentOrigin||'*');
function rpc(action,data){return new Promise((resolve,reject)=>{const requestId=crypto.randomUUID(),timer=setTimeout(()=>{pending.delete(requestId);reject(Error('请求超时，请重试'))},35000);pending.set(requestId,{resolve,reject,timer});post({action,data,requestId})})}
addEventListener('message',event=>{
if(event.source!==parent||!event.data||event.data.namespace!==namespace)return;
const m=event.data;if(initialized&&event.origin!==parentOrigin)return;
if(m.init&&!initialized){parentOrigin=event.origin;initialized=true;lastRead=m.lastRead||'';for(const [id,p] of Object.entries(m.outbox||{}))local.set(id,{...p,error:'消息尚未确认，请点击重试'});render();document.documentElement.style.setProperty('--theme',m.init.color);$('name').textContent=m.init.name;$('welcome').textContent=m.init.welcome||'您好，有什么可以帮助您？';sync();setInterval(sync,4000);return}
if(!initialized)return;const p=pending.get(m.requestId);if(p){clearTimeout(p.timer);pending.delete(m.requestId);m.error?p.reject(Error(m.error)):p.resolve(m.result)}
});
function setOpen(value){open=value;$('panel').hidden=!value;$('launcher').hidden=value;post({action:'expand',open:value});if(value){markRead();$('draft').focus();sync()}}
$('launcher').onclick=()=>setOpen(true);$('close').onclick=()=>setOpen(false);
function markRead(){if(latest){lastRead=latest;post({action:'read',id:latest})}$('badge').hidden=true}
function render(){const timeline=$('timeline'),bottom=timeline.scrollHeight-timeline.scrollTop-timeline.clientHeight<80;const list=$('messages');list.replaceChildren();
const sortTime=m=>m.sort_at||(m.visible_at||m.created_at).replace(/\.(\d{3})Z$/,(_match,millis)=>'.'+millis+'000Z');
const sorted=Array.from(messages.values()).sort((a,b)=>sortTime(a).localeCompare(sortTime(b))||a.id.localeCompare(b.id));
for(const m of sorted){local.delete(m.client_message_id);const row=document.createElement('div');row.className='message '+(m.direction==='in'?'out':'in');const bubble=document.createElement('div');bubble.className='bubble';if(m.text_content)bubble.textContent=m.text_content;
if(m.media_id){const btn=document.createElement('button');btn.className='attachment';btn.textContent=m.file_name||'下载附件';btn.onclick=async()=>{btn.disabled=true;try{const result=await rpc('download',{id:m.media_id});const url=URL.createObjectURL(result.blob);if((m.mime_type||'').startsWith('image/')&&!btn.querySelector('img')){const img=document.createElement('img');img.alt=m.file_name||'图片';img.src=url;btn.replaceChildren(img);img.onload=()=>URL.revokeObjectURL(url)}else{const a=document.createElement('a');a.href=url;a.download=m.file_name||'attachment';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}}catch(error){notice(error.message)}finally{btn.disabled=false}};bubble.append(btn)}
row.append(bubble);const time=document.createElement('small');time.textContent=new Date(m.created_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});row.append(time);list.append(row)}
for(const [id,p] of local){const row=document.createElement('div');row.className='message out';const bubble=document.createElement('div');bubble.className='bubble';bubble.textContent=p.text||p.fileName||'附件';const status=document.createElement(p.error?'button':'small');status.textContent=p.error?'发送失败，点击重试':'发送中...';if(p.error){status.title=p.error;status.onclick=()=>send(p,id)}row.append(bubble,status);list.append(row)}
const incoming=sorted.filter(m=>m.direction==='out');latest=incoming.at(-1)?.id||'';if(open&&document.visibilityState==='visible')markRead();else if(latest&&latest!==lastRead){const lastIndex=incoming.findIndex(m=>m.id===lastRead);$('badge').textContent=String(Math.min(99,incoming.length-lastIndex-1));$('badge').hidden=false}
first=sorted[0]?.id||'';$('older').hidden=!hasMore;if(bottom)timeline.scrollTop=timeline.scrollHeight;
}
function notice(text){$('notice').textContent=({'livechat_rate_limited':'请求频繁，请稍后重试','livechat_unavailable':'客服渠道暂不可用','visitor_session_expired':'会话已过期，历史记录仍由客服保留，可开始新会话','visitor_not_found_or_expired':'会话尚未开始或已过期','unsupported_attachment_type':'支持 PNG、JPEG、WebP、PDF 和纯文本文件'}[text]||text)}
async function sync(){if(!initialized||syncing)return;syncing=true;try{const incremental=!!cursor;let result=await rpc('history',cursor?{after:cursor}:undefined);active=true;for(const m of result.data)messages.set(m.id,m);if(result.data.length)cursor=result.data.at(-1).id;if(!incremental)hasMore=result.hasMore;$('connection').textContent='在线客服';$('restart').hidden=true;if($('notice').textContent==='连接中断，正在重试...')notice('');render();if(incremental&&result.hasMore)setTimeout(sync,600)}catch(error){if(error.message==='visitor_session_expired'){$('restart').hidden=false;notice(error.message);$('connection').textContent='会话已过期'}else if(error.message!=='visitor_not_found_or_expired'){notice(error.message==='Failed to fetch'?'连接中断，正在重试...':error.message);$('connection').textContent='正在重新连接'}}finally{syncing=false}}
$('restart').onclick=async()=>{if(!confirm('开始新的匿名会话？当前浏览器将不再显示原会话，客服仍保留历史记录。'))return;try{await rpc('reset');messages.clear();local.clear();active=false;cursor='';latest='';lastRead='';hasMore=false;$('visitorName').value='';$('email').value='';$('draft').value='';$('restart').hidden=true;notice('');$('connection').textContent='欢迎与我们联系';render()}catch(error){notice(error.message)}};
$('older').onclick=async()=>{if(!first)return;const timeline=$('timeline'),height=timeline.scrollHeight;$('older').disabled=true;try{const result=await rpc('history',{before:first});for(const m of result.data)messages.set(m.id,m);hasMore=result.hasMore;render();timeline.scrollTop=timeline.scrollHeight-height}catch(error){notice(error.message)}finally{$('older').disabled=false}};
async function send(p,id){if(busy)return;busy=true;p.error='';local.set(id,p);$('send').disabled=true;render();notice('');try{const result=await rpc('send',{clientMessageId:id,text:p.text,mediaId:p.mediaId,name:p.name||$('visitorName').value||undefined,email:p.email||$('email').value||undefined});active=true;local.delete(id);messages.set(result.id,{id:result.id,client_message_id:id,direction:'in',text_content:p.text,media_id:p.mediaId,file_name:p.fileName,created_at:new Date().toISOString()});await sync()}catch(error){p.error=error.message;notice(error.message)}finally{busy=false;$('send').disabled=false;render()}}
$('form').onsubmit=event=>{event.preventDefault();const text=$('draft').value.trim();if(!text||busy||uploading)return;if($('email').value&&!$('email').checkValidity()){$('email').reportValidity();return}$('draft').value='';send({text},crypto.randomUUID())};
$('draft').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();$('form').requestSubmit()}};
$('attach').onclick=()=>{if(busy||uploading)return;if(!active){notice('请先发送一条消息，再添加附件');return}$('file').click()};
$('file').onchange=async()=>{if(busy||uploading)return;const file=$('file').files[0];if(!file)return;$('file').value='';if(file.size>10485760){notice('附件不能超过 10 MB');return}uploading=true;$('attach').disabled=true;try{const result=await rpc('upload',{file});await send({text:'',mediaId:result.id,fileName:file.name},crypto.randomUUID())}catch(error){notice(error.message)}finally{uploading=false;$('attach').disabled=false}};
addEventListener('online',sync);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){sync();if(open)markRead()}});post({action:'ready'});
})();
</script></body></html>`;
