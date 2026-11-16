// 本脚本使用真实嵌入资源与模拟 API，不替代 PostgreSQL、对象存储和 AI 的部署验收。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {randomUUID} from "node:crypto";
import {mkdir,mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {chromium,firefox,webkit} from "playwright";
import {livechatLoader,livechatWidget} from "../services/api/dist/livechat-widget.js";

const channel="11111111-1111-4111-8111-111111111111";
const testPng=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAHUlEQVR4nGNgaIr6TxFmGDWAYTQM/o+GQdRwCAMAqf3bEFNOlTwAAAAASUVORK5CYII=','base64');
const secondChannel="22222222-2222-4222-8222-222222222222";
const sessions=new Map(),uploads=new Map(),origins=new Set(),errors=[],profiles=[],expiredSessions=new Set();
const transcripts=new Map(),closedChats=new Map(),endRequests=[];
const presenceReports=[];
let endError='',dropEndResponse=false;
let failNext=false,ordinal=0,widgetLanguage,widgetName='网站客服',widgetIcon='';
const timestamp=()=>new Date().toISOString().replace(/\.(\d{3})Z$/,(_match,millis)=>`.${millis}${String(++ordinal%1000).padStart(3,'0')}Z`);
const listen=async handler=>{
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}`};
};
const body=async req=>{const parts=[];for await(const chunk of req)parts.push(chunk);return Buffer.concat(parts)};
const api=await listen(async(req,res)=>{
  const url=new URL(req.url,"http://localhost"),cors={"access-control-allow-origin":req.headers.origin||"",vary:"Origin","access-control-allow-headers":"authorization,content-type","access-control-allow-methods":"GET,POST,OPTIONS"};
  const json=(status,data)=>{res.writeHead(status,{...cors,"content-type":"application/json"});res.end(JSON.stringify(data))};
  if(req.method==="OPTIONS"){res.writeHead(204,cors);res.end();return}
  if(url.pathname==="/livechat/embed.js"){res.writeHead(200,{"content-type":"application/javascript"});res.end(livechatLoader);return}
  if(url.pathname.endsWith("/widget")){res.writeHead(200,{"content-type":"text/html","content-security-policy":`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: https:; frame-ancestors ${[...origins].join(" ")}`});res.end(livechatWidget);return}
  if(!origins.has(req.headers.origin)){json(403,{error:"livechat_origin_denied"});return}
  if(url.pathname.endsWith("/config")){json(200,{name:widgetName,iconUrl:widgetIcon,welcome:widgetLanguage!==undefined?"":"您好，欢迎联系我们。",color:"#146d73",position:url.pathname.includes(secondChannel)?"left":"right",language:widgetLanguage===null?undefined:widgetLanguage||(url.pathname.includes(secondChannel)?"en":"zh-CN")});return}
  const secret=req.headers.authorization,sessionKey=`${url.pathname.split('/')[2]}:${req.headers.origin}:${secret}`;
  if(!/^Bearer [a-f0-9]{64}$/.test(secret||"")){json(401,{error:"invalid_visitor_credential"});return}
  if(expiredSessions.has(sessionKey)){json(401,{error:"visitor_not_found_or_expired"});return}
  if(url.pathname.endsWith("/messages")&&req.method==="POST"){
    const data=JSON.parse((await body(req)).toString());
    if(failNext){failNext=false;json(503,{error:"测试网络中断"});return}
    if(!sessions.has(sessionKey)){
      if(!data.name?.trim()||!data.email?.includes('@')||!data.text?.trim()){json(400,{error:"prechat_details_required"});return}
      profiles.push(data);
    }
    const messages=sessions.get(sessionKey)||[];sessions.set(sessionKey,messages);
    let message=messages.find(m=>m.client_message_id===data.clientMessageId);
    if(!message){const upload=uploads.get(data.mediaId);message={id:randomUUID(),client_message_id:data.clientMessageId,direction:"in",text_content:data.text,media_id:data.mediaId,file_name:upload?.name,mime_type:upload?.mime,created_at:timestamp()};messages.push(message)}
    json(201,{id:message.id});return;
  }
  const messages=sessions.get(sessionKey);
  if(!messages){json(401,{error:"visitor_not_found_or_expired"});return}
  if(url.pathname.endsWith('/presence')){presenceReports.push({...JSON.parse((await body(req)).toString()),sessionKey});json(200,{ok:true});return}
  if(url.pathname.endsWith('/end-chat')&&req.method==='POST'){
    const data=JSON.parse((await body(req)).toString());endRequests.push(data);
    if(endError&&data.sendTranscript!==false){json(409,{error:endError});return}
    if(data.sendTranscript===false){if(!closedChats.has(data.clientRequestId))closedChats.set(data.clientRequestId,sessionKey)}
    else if(!transcripts.has(data.clientRequestId))transcripts.set(data.clientRequestId,sessionKey);
    if(dropEndResponse){dropEndResponse=false;json(503,{error:'response_lost'});return}
    json(202,{ok:true,queued:data.sendTranscript!==false,closed:true,sendTranscript:data.sendTranscript!==false});return;
  }
  if(url.pathname.endsWith("/messages")){
    const after=url.searchParams.get("after"),before=url.searchParams.get("before");
    const ordered=[...messages].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
    const data=after?ordered.slice(ordered.findIndex(m=>m.id===after)+1):before?ordered.slice(0,ordered.findIndex(m=>m.id===before)):ordered;
    const page=before?data.slice(-100):after?data.slice(0,100):data.slice(-100);
    json(200,{data:page.map(message=>({...message,sort_at:message.created_at,created_at:new Date(message.created_at).toISOString()})),hasMore:data.length>100});return;
  }
  if(url.pathname.endsWith("/media")&&req.method==="POST"){
    const form=await new Request(url,{method:'POST',headers:{'content-type':req.headers['content-type']},body:await body(req)}).formData(),file=form.get('file'),id=randomUUID();
    uploads.set(id,{name:file.name,mime:file.type,bytes:Buffer.from(await file.arrayBuffer())});json(201,{id});return;
  }
  const upload=uploads.get(url.pathname.split("/").at(-1));
  if(upload){res.writeHead(200,{...cors,"content-type":upload.mime});res.end(upload.bytes);return}
  json(404,{error:"not_found"});
});
const hosts=[];
for(let index=0;index<2;index++){
  const host=await listen((_req,res)=>{res.writeHead(200,{"content-type":"text/html; charset=utf-8"});res.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>嵌入网站 ${index+1}</title><style>body{font:16px system-ui;margin:24px;color:#24332f}button{background:#d94949;color:#fff;padding:12px}iframe{width:5px!important}*{box-sizing:content-box}</style><h1>测试网站 ${index+1}</h1><p>独立网站内容</p><button>宿主按钮</button><script async src="${api.url}/livechat/embed.js" data-channel="${channel}"></script></html>`)});
  origins.add(host.url);hosts.push(host);
}
const browserType={chromium,firefox,webkit}[process.env.LIVECHAT_TEST_BROWSER||'chromium'];
assert.ok(browserType,'LIVECHAT_TEST_BROWSER 必须为 chromium、firefox 或 webkit');
const browser=await browserType.launch({headless:true});
const uploadFixtureDir=await mkdtemp(join(tmpdir(),'livechat-upload-'));
const screenshots=fileURLToPath(new URL(`../outputs/livechat/${browserType.name()}/`,import.meta.url));await mkdir(screenshots,{recursive:true});
const frameFor=async page=>{await page.waitForFunction(()=>document.querySelector('div')?.shadowRoot===null);for(let i=0;i<50;i++){const frame=page.frames().find(f=>f.url().endsWith("/widget"));if(frame){await frame.locator("#launcher:visible, #panel:visible").waitFor({state:"visible"});return frame}await page.waitForTimeout(100)}throw Error("窗口未加载")};
const incoming=(messages,text)=>messages.push({id:randomUUID(),direction:"out",text_content:text,created_at:timestamp()});
const openChat=async frame=>{if(await frame.locator('#launcher').isVisible())await frame.locator('#launcher').click();await frame.locator('#panel').waitFor({state:'visible'})};
const assertWindowControls=async(page,frame,label)=>{
  const control=frame.locator('#maximize'),element=await frame.frameElement();
  const normal=await element.boundingBox();
  const leftDocked=normal.x===16;
  const maximizedBounds=viewport=>{const narrow=viewport.width<=600,width=narrow?viewport.width-16:390;return {x:narrow?8:leftDocked?16:viewport.width-16-width,y:8,width,height:viewport.height-16}};
  const waitForBounds=async bounds=>{await frame.waitForFunction(({width,height})=>innerWidth===width&&innerHeight===height,bounds);assert.deepEqual(await element.boundingBox(),bounds)};
  const expandIcon=await control.innerHTML();
  assert.deepEqual(await frame.locator('#close svg path').evaluateAll(paths=>paths.map(path=>path.getAttribute('d'))),['M18 6 6 18','m6 6 12 12'],'收起按钮使用 X 图标');
  await control.click();const viewport=page.viewportSize();
  await waitForBounds(maximizedBounds(viewport));
  if(viewport.width>600){
    const full=await element.boundingBox();assert.equal(full.width,normal.width,'PC 放大仅扩展高度，宽度不变');assert.equal(full.x,normal.x,'PC 放大保持左右停靠位置');
    if(!leftDocked)await page.getByRole('button',{name:'宿主按钮',exact:true}).click({trial:true});
  }
  assert.equal(await control.getAttribute('aria-pressed'),'true');
  assert.notEqual(await control.innerHTML(),expandIcon,'放大后切换为还原图标');
  assert.equal(await frame.evaluate(()=>{const title=document.querySelector('header .title').getBoundingClientRect(),button=document.querySelector('#maximize').getBoundingClientRect(),close=document.querySelector('#close').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&title.right<=button.left&&button.right<=close.left&&close.right<=innerWidth}),true,'标题和控件不重叠且无水平溢出');
  await page.screenshot({path:`${screenshots}/${label}-maximized.png`});
  await page.setViewportSize({width:viewport.width-24,height:viewport.height-24});
  await waitForBounds(maximizedBounds(page.viewportSize()));
  if(viewport.width>600){
    for(const width of [600,601]){await page.setViewportSize({width,height:viewport.height});await waitForBounds(maximizedBounds(page.viewportSize()))}
  }
  await page.setViewportSize(viewport);
  await waitForBounds(maximizedBounds(viewport));
  await frame.locator('#close').click();await frame.locator('#launcher').waitFor({state:'visible'});
  await frame.waitForFunction(()=>innerWidth===72);await openChat(frame);
  await waitForBounds(maximizedBounds(viewport));
  await control.click();await waitForBounds(normal);
  assert.equal(await control.getAttribute('aria-pressed'),'false');
  assert.equal(await control.innerHTML(),expandIcon);
};
const assertMessageLayout=async frame=>{
  const result=await frame.evaluate(()=>{
    const rows=[...document.querySelectorAll('.message')];
    return rows.every(row=>{
      const avatar=row.querySelector('.message-avatar'),bubble=row.querySelector('.bubble'),reply=row.querySelector('.reply-message');
      if(!avatar||!bubble)return false;
      const a=avatar.getBoundingClientRect(),b=bubble.getBoundingClientRect(),r=reply?.getBoundingClientRect();
      const visitor=row.classList.contains('out');
      const tail=getComputedStyle(bubble,'::before'),style=getComputedStyle(bubble);
      const tailCenter=b.top+bubble.clientTop+parseFloat(tail.top);
      const alignedTail=tail.content!== 'none'&&tail.content!=='normal'&&
        Math.abs(tailCenter-(a.top+a.height/2))<=1&&tail.backgroundColor===style.backgroundColor&&
        (visitor?parseFloat(tail.right)<0&&parseFloat(tail.left)>=0:parseFloat(tail.left)<0);
      return (visitor?a.left>=b.right&&avatar.textContent==='Me':a.right<=b.left)&&
        alignedTail&&(!r||((visitor?r.right<=b.left:r.left>=b.right)&&getComputedStyle(reply).opacity==='1'));
    })&&rows.length>0&&document.querySelector('#composerTools').getBoundingClientRect().bottom<=document.querySelector('#draft').getBoundingClientRect().top&&Math.abs(document.querySelector('#send').getBoundingClientRect().top-document.querySelector('#draft').getBoundingClientRect().top)<=1;
  });
  assert.equal(result,true,'头像方向正确，气泡尖角对齐头像中心，访客回复按钮在气泡左边、客服回复按钮在右边，工具栏在输入框上方');
};
const startChat=async(frame,text)=>{
  await frame.locator('#visitorName').fill('Sam');await frame.locator('#email').fill('sam@example.com');
  await frame.locator('#company').fill('Example Ltd');await frame.locator('#whatsapp').fill('+12025550123');
  await frame.locator('#initialMessage').fill(text);await frame.locator('#start').click();
  await frame.locator('#form').waitFor({state:'visible'});
};
const assertReplyLayout=async frame=>{
  await frame.locator('.reply-message').first().click();
  await frame.locator('#replyBar').waitFor({state:'visible'});
  assert.equal(await frame.evaluate(()=>{
    const quote=document.querySelector('#replyBar'),tools=document.querySelector('#composerTools'),actions=document.querySelector('#endActions');
    const q=quote.getBoundingClientRect(),t=tools.getBoundingClientRect(),a=actions.getBoundingClientRect();
    return quote.parentElement.id==='form'&&quote.nextElementSibling===tools&&a.bottom<=q.top&&q.bottom<=t.top&&Math.abs(q.left-t.left)<=1&&q.height>0;
  }),true,'引用预览位于结束会话按钮下方、工具栏正上方，与输入区域左侧对齐');
};
let debugPage;
try{
  const context=await browser.newContext({viewport:{width:1280,height:850}}),page=await context.newPage();
  debugPage=page;
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(hosts[0].url);let frame=await frameFor(page);
  assert.equal(await frame.locator('#panel').isVisible(),false,'首次访问默认收起');
  await openChat(frame);
  await assertWindowControls(page,frame,'desktop');
  await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(':expanded')&&localStorage.getItem(k)==='1'));
  await page.goto(hosts[0].url+'/products');frame=await frameFor(page);await frame.locator('#panel').waitFor({state:'visible'});
  await frame.locator('#close').click();
  await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(':expanded')&&localStorage.getItem(k)==='0'));
  await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(':expanded')&&localStorage.getItem(k)==='0'));
  await page.goto(hosts[0].url+'/contact');frame=await frameFor(page);await frame.locator('#launcher').waitFor({state:'visible'});
  assert.equal(await frame.locator('#panel').isVisible(),false,'跨页面保持收起');
  await openChat(frame);
  await page.reload();frame=await frameFor(page);await frame.locator('#panel').waitFor({state:'visible'});
  await frame.locator('#start').click();assert.equal(sessions.size,0);
  assert.equal(await frame.locator('#visitorName').getAttribute('required'),'');
  await page.screenshot({path:`${screenshots}/desktop-prechat.png`});
  failNext=true;
  await frame.locator('#visitorName').fill('Sam');await frame.locator('#email').fill('sam@example.com');await frame.locator('#company').fill('Example Ltd');await frame.locator('#whatsapp').fill('+12025550123');await frame.locator('#initialMessage').fill('第一条匿名消息');await frame.locator('#start').click();
  await frame.getByText('发送失败，点击重试').waitFor();
  await assertMessageLayout(frame);
  await page.reload();frame=await frameFor(page);await openChat(frame);await frame.getByText('发送失败，点击重试').click();
  await frame.getByText("第一条匿名消息",{exact:true}).waitFor();await frame.locator("#send").waitFor({state:"visible"});
  await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(":started")));
  const firstSession=[...sessions.values()][0];assert.equal(firstSession.length,1);
  assert.equal(profiles[0].name,'Sam');assert.equal(profiles[0].email,'sam@example.com');assert.equal(profiles[0].company,'Example Ltd');assert.equal(profiles[0].whatsapp,'+12025550123');
  assert.ok(profiles[0].context.browserLanguage);assert.ok(profiles[0].context.timeZone);assert.equal(profiles[0].context.pageUrl,hosts[0].url+'/contact');
  const waitPresence=async predicate=>{for(let i=0;i<60;i++){if(presenceReports.some(predicate))return;await page.waitForTimeout(100)}assert.fail('未收到预期访客心跳')};
  await waitPresence(item=>item.pageUrl===hosts[0].url+'/contact'&&item.connected);
  const originalPresence=presenceReports.at(-1);
  await page.evaluate(()=>history.pushState({},'', '/live-products?private=1#secret'));
  await waitPresence(item=>item.pageUrl===hosts[0].url+'/live-products'&&item.connected);
  assert.equal(firstSession.length,1,'更新当前浏览页面无需再发消息');
  await page.goto(hosts[0].url+'/presence-next');frame=await frameFor(page);await openChat(frame);
  await waitPresence(item=>item.sessionId===originalPresence.sessionId&&!item.connected);
  await waitPresence(item=>item.pageUrl===hosts[0].url+'/presence-next'&&item.connected&&item.sessionId!==originalPresence.sessionId);
  incoming(firstSession,"坐席回复已送达");await frame.getByText("坐席回复已送达",{exact:true}).waitFor({timeout:10000});
  await assertMessageLayout(frame);
  assert.equal(await frame.locator('.support-avatar').first().textContent(),await frame.locator('#avatar').textContent());
  await assertReplyLayout(frame);
  await page.screenshot({path:`${screenshots}/desktop-reply.png`});
  await frame.locator('#replyBar button').click();await frame.locator('#replyBar').waitFor({state:'hidden'});
  await page.screenshot({path:`${screenshots}/desktop.png`});
  await page.evaluate(()=>{const original=document.querySelector('script[data-channel]'),copy=document.createElement('script');copy.src=original.src;copy.dataset.channel=original.dataset.channel;document.body.append(copy)});
  await page.waitForLoadState("networkidle");assert.equal(page.frames().filter(f=>f.url().endsWith("/widget")).length,1);
  await page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.endsWith(':outbox')),messageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';localStorage.setItem(key,JSON.stringify({[messageId]:{text:'已接收但确认丢失'}}))});
  firstSession.push({id:randomUUID(),client_message_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',text_content:'已接收但确认丢失',created_at:timestamp()});
  await page.reload();frame=await frameFor(page);await openChat(frame);await frame.getByText("第一条匿名消息",{exact:true}).waitFor();
  await page.waitForFunction(()=>Object.keys(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(':outbox')))||'{}')).length===0);
  failNext=true;await frame.locator("#draft").fill("刷新后重试");await frame.locator("#send").click();await frame.getByText("发送失败，点击重试").waitFor();
  await page.reload();frame=await frameFor(page);await openChat(frame);await frame.getByText("发送失败，点击重试").click();
  await page.waitForFunction(()=>Object.keys(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(":outbox")))||"{}")).length===0);
  assert.equal(firstSession.filter(m=>m.text_content==="刷新后重试").length,1);
  await frame.locator("#close").click();incoming(firstSession,"未读回复");await frame.locator("#badge").waitFor({state:"visible",timeout:10000});await openChat(frame);assert.equal(await frame.locator("#badge").isVisible(),false);
  await context.setOffline(true);incoming(firstSession,"断线期间回复");await page.waitForTimeout(4200);await context.setOffline(false);await frame.getByText("断线期间回复",{exact:true}).waitFor({timeout:12000});
  assert.equal(await frame.locator('#emoji svg,#image svg,#attach svg,#send svg').count(),4);
  // 从真实跨域 iframe 发出无效上传，宿主必须在请求网络前拒绝。
  const uploadCount=uploads.size;
  for(const [kind,expected] of [['legacy','upload_file_payload_invalid'],['empty','upload_file_payload_invalid'],['oversize','file_too_large'],['mime','unsupported_attachment_type']]){
    const error=await frame.evaluate(async kind=>{
      const requestId=crypto.randomUUID(),data={name:'test.txt',type:kind==='mime'?'text/html':'text/plain',bytes:new ArrayBuffer(kind==='oversize'?10485761:kind==='empty'?0:4)};
      if(kind==='legacy'){delete data.bytes;data.file=new File(['test'],'test.txt',{type:'text/plain'})}
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{removeEventListener('message',listener);reject(Error('未收到上传校验结果'))},5000);
        const listener=event=>{if(event.source===parent&&event.data?.requestId===requestId){clearTimeout(timer);removeEventListener('message',listener);resolve(event.data.error)}};
        addEventListener('message',listener);parent.postMessage({namespace:'relaydesk-livechat',action:'upload',data,requestId},'*');
      });
    },kind);
    assert.equal(error,expected);
  }
  assert.equal(uploads.size,uploadCount,'无效文件不应上传');
  await page.evaluate(()=>{window.uploadPayloads=[];addEventListener('message',event=>{if(event.data?.namespace==='relaydesk-livechat'&&event.data.action==='upload')window.uploadPayloads.push({bytes:event.data.data.bytes instanceof ArrayBuffer,hasFile:'file' in event.data.data})})});
  await frame.locator("#file").setInputFiles({name:"remove.txt",mimeType:"text/plain",buffer:Buffer.from("remove")});await frame.locator('#composerPreview').getByText("remove.txt",{exact:true}).waitFor();await frame.locator('#composerPreview').getByRole('button',{name:'移除附件'}).click();await frame.locator('#composerPreview').waitFor({state:'hidden'});
  await frame.locator("#file").setInputFiles({name:"sample.txt",mimeType:"text/plain",buffer:Buffer.from("test")});await frame.locator('#composerPreview').getByText("sample.txt",{exact:true}).waitFor();
  await frame.locator('#draft').fill('附件说明');await frame.locator('#send').click();await frame.locator('#composerPreview').waitFor({state:'hidden'});await frame.getByRole('button',{name:'sample.txt',exact:true}).waitFor();
  const download=page.waitForEvent("download");await frame.getByRole("button",{name:"sample.txt",exact:true}).click();assert.equal((await download).suggestedFilename(),"sample.txt");
  const png=testPng;
  const imageFileName='BelaroPrecision_工程卓越徽标.png';
  const imagePath=join(uploadFixtureDir,imageFileName);await writeFile(imagePath,png);
  await frame.locator('#image').click();await frame.locator('#file').setInputFiles(imagePath);await frame.locator('#composerPreview img').waitFor();
  // 模拟本地文件读取失败，必须恢复控件并保留原附件，且不得发送请求。
  await frame.evaluate(()=>{window.originalArrayBuffer=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async()=>{throw new DOMException('文件读取失败','NotReadableError')}});
  const beforeReadFailure=uploads.size;
  await frame.locator('#draft').fill('读取失败后重试');await frame.locator('#send').click();
  await frame.getByText('发送失败，请重试',{exact:true}).waitFor();
  await frame.waitForFunction(()=>!document.querySelector('#send').disabled);
  assert.equal(uploads.size,beforeReadFailure);assert.equal(await frame.locator('#composerPreview img').count(),1);
  assert.equal(await frame.locator('#draft').inputValue(),'读取失败后重试');
  await frame.evaluate(()=>{File.prototype.arrayBuffer=window.originalArrayBuffer;delete window.originalArrayBuffer});
  // 上传连接中断不能阻塞独立收信；文件和说明必须保留以便重试。
  const abortUpload=route=>route.request().method()==='POST'?route.abort('failed'):route.continue();
  await page.route('**/media',abortUpload);
  await frame.locator('#draft').fill('图片上传断线重试');await frame.locator('#send').click();
  await frame.getByText('发送失败，请重试',{exact:true}).waitFor();
  await frame.waitForFunction(()=>!document.querySelector('#send').disabled);
  assert.equal(await frame.locator('#composerPreview img').count(),1);
  assert.equal(await frame.locator('#draft').inputValue(),'图片上传断线重试');
  incoming(firstSession,'上传失败后仍能收信');
  await frame.getByText('上传失败后仍能收信',{exact:true}).waitFor({timeout:12000});
  await page.unroute('**/media',abortUpload);
  await frame.locator('#emoji').click();await frame.locator('#emojiPanel button').first().click();assert.ok((await frame.locator('#draft').inputValue()).length>0);
  await frame.locator('#send').click();const sentImage=frame.locator('.attachment-image img').filter({visible:true});await sentImage.waitFor();await frame.waitForFunction(()=>document.querySelector('.attachment-image img')?.naturalWidth>0);assert.equal(await sentImage.getAttribute('alt'),imageFileName);await sentImage.click();await frame.locator('dialog.image-preview').waitFor();await page.screenshot({path:`${screenshots}/desktop-media-preview.png`});await frame.locator('dialog.image-preview').getByText('取消',{exact:true}).click();
  const uploadedImage=[...uploads.values()].find(file=>file.name===imageFileName);
  assert.equal(uploadedImage.mime,'image/png');assert.deepEqual(uploadedImage.bytes,png,'本地图片上传字节必须完全一致');
  assert.deepEqual([...uploads.values()].find(file=>file.name==='sample.txt').bytes,Buffer.from('test'));
  assert.ok((await page.evaluate(()=>window.uploadPayloads)).every(payload=>payload.bytes&&!payload.hasFile),'跨域上传仅传递 ArrayBuffer，不传递 File');
  // 不可用图片只自动尝试一次，重绘与后续收信不得反复消耗下载额度。
  const failedMedia=new Map();
  const failImages=route=>{const id=route.request().url().split('/').at(-1);if(!failedMedia.has(id)||uploads.has(id))return route.continue();failedMedia.set(id,failedMedia.get(id)+1);return route.fulfill({status:503,headers:{'access-control-allow-origin':hosts[0].url},contentType:'application/json',body:JSON.stringify({error:'storage_unavailable'})})};
  await page.route('**/media/*',failImages);
  for(let index=0;index<8;index++){const mediaId=randomUUID();failedMedia.set(mediaId,0);firstSession.push({id:randomUUID(),direction:'out',text_content:`失败图片 ${index}`,media_id:mediaId,file_name:`failed-${index}.png`,mime_type:'image/png',created_at:timestamp()})}
  await frame.locator('.message').filter({hasText:'失败图片 7'}).waitFor({timeout:12000});
  await frame.waitForFunction(()=>[...document.querySelectorAll('.attachment-image')].filter(button=>!button.querySelector('img')).every(button=>!button.disabled));
  for(let index=0;index<3;index++){
    incoming(firstSession,`图片失败后回复 ${index}`);
    await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await frame.getByText(`图片失败后回复 ${index}`,{exact:true}).waitFor({timeout:12000});
  }
  assert.deepEqual([...failedMedia.values()],Array(8).fill(1),'失败图片不能在每次收信刷新时自动重试');
  for(const viewport of [{width:320,height:460},{width:1280,height:850}]){
    await page.setViewportSize(viewport);
    assert.equal(await frame.evaluate(()=>[...document.querySelectorAll('.attachment-loading')].every(placeholder=>{const p=placeholder.getBoundingClientRect(),b=placeholder.closest('.bubble').getBoundingClientRect();return p.left>=b.left&&p.right<=b.right&&p.top>=b.top&&p.bottom<=b.bottom})),true,'失败占位内容不能溢出消息气泡');
    if(viewport.width===320)await page.screenshot({path:`${screenshots}/mobile-media-failure.png`});
  }
  const retryId=[...failedMedia.keys()][0];
  await frame.locator('.message').filter({hasText:'失败图片 0'}).locator('.attachment-image').click();
  await frame.waitForFunction(()=>!document.querySelector('.attachment-image:not(:has(img))')?.disabled);
  assert.equal(failedMedia.get(retryId),2,'失败图片仍可手动重试');
  uploads.set(retryId,{name:'failed-0.png',mime:'image/png',bytes:png});
  await frame.locator('.message').filter({hasText:'失败图片 0'}).locator('.attachment-image').click();
  await frame.locator('.attachment-image img[alt="failed-0.png"]').waitFor();
  await page.screenshot({path:`${screenshots}/media-failure-recovery.png`});
  // 收信被临时限流后自动恢复，发送不受收信失败影响。
  let limited=true;
  const limitHistory=route=>route.request().method()==='GET'&&limited?route.fulfill({status:429,headers:{'access-control-allow-origin':hosts[0].url},contentType:'application/json',body:JSON.stringify({error:'livechat_rate_limited'})}):route.continue();
  await page.route('**/messages*',limitHistory);
  await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
  await frame.locator('#connection').getByText('正在重新连接',{exact:true}).waitFor();
  await frame.locator('#draft').fill('限流期间仍可发送');await frame.locator('#send').click();
  await frame.getByText('限流期间仍可发送',{exact:true}).waitFor();
  limited=false;incoming(firstSession,'限流解除后恢复收信');
  await frame.getByText('限流解除后恢复收信',{exact:true}).waitFor({timeout:12000});
  await frame.locator('#connection').getByText('在线客服',{exact:true}).waitFor();
  assert.equal(await frame.locator('#notice').textContent(),'');
  await page.unroute('**/messages*',limitHistory);await page.unroute('**/media/*',failImages);
  await assertMessageLayout(frame);
  for(let i=0;i<205;i++)incoming(firstSession,`分页回复 ${i}`);
  await frame.getByText('分页回复 204',{exact:true}).waitFor({timeout:15000});
  await page.reload();frame=await frameFor(page);await openChat(frame);await frame.getByText('分页回复 204',{exact:true}).waitFor();
  await frame.locator('#older').click();await frame.getByText('分页回复 5',{exact:true}).waitFor();await frame.locator('#older').click();await frame.getByText('第一条匿名消息',{exact:true}).waitFor();
  for(const viewport of [{width:1280,height:850},{width:320,height:460}]){
    await page.setViewportSize(viewport);
    const scrollUp=()=>frame.evaluate(()=>{document.querySelector('#timeline').scrollTop=0});
    const waitForLatest=()=>frame.waitForFunction(()=>{const t=document.querySelector('#timeline');return t.clientHeight>0&&t.scrollHeight-t.scrollTop-t.clientHeight<=1});
    await scrollUp();
    const historyText=`翻阅历史时的新消息 ${viewport.width}`;incoming(firstSession,historyText);
    await frame.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await frame.getByText(historyText,{exact:true}).waitFor();
    assert.equal(await frame.locator('#timeline').evaluate(t=>t.scrollTop),0,'普通收信同步不能打断历史浏览');
    const sentText=`历史位置发送 ${viewport.width}`;
    await frame.locator('#draft').fill(sentText);await scrollUp();
    await frame.locator('#send').click();
    await frame.getByText(sentText,{exact:true}).waitFor();await waitForLatest();
    await frame.waitForFunction(()=>!document.querySelector('#send').disabled);
    await frame.locator('#file').setInputFiles({name:'scroll-test.txt',mimeType:'text/plain',buffer:Buffer.from('scroll test')});
    await scrollUp();await frame.locator('#send').click();
    await frame.waitForFunction(()=>!document.querySelector('#send').disabled);await waitForLatest();
    failNext=true;await frame.locator('#draft').fill(`失败重试滚动 ${viewport.width}`);await scrollUp();
    await frame.locator('#send').click();
    await frame.getByText('发送失败，点击重试',{exact:true}).waitFor();await waitForLatest();
    await scrollUp();
    await frame.getByText('发送失败，点击重试',{exact:true}).evaluate(button=>button.click());
    await frame.waitForFunction(()=>!document.querySelector('#send').disabled);await waitForLatest();
    for(const maximized of [true,false]){
      await scrollUp();await frame.locator('#maximize').click();
      await frame.waitForFunction(height=>innerHeight===height,maximized?viewport.height-16:Math.min(640,viewport.height-32));
      await waitForLatest();
      assert.equal(await frame.locator('#maximize').getAttribute('aria-pressed'),String(maximized));
      await page.screenshot({path:`${screenshots}/scroll-${viewport.width}-${maximized?'maximized':'restored'}.png`});
    }
    await frame.evaluate(()=>{document.querySelector('#timeline').scrollTop=0});
    assert.equal(await frame.evaluate(()=>{const t=document.querySelector('#timeline');return t.scrollHeight-t.scrollTop-t.clientHeight>80}),true,'测试前停留在历史消息');
    await frame.locator('#close').click();await openChat(frame);
    await frame.waitForFunction(()=>{const t=document.querySelector('#timeline');return t.clientHeight>0&&t.scrollHeight-t.scrollTop-t.clientHeight<=1});
    await frame.evaluate(()=>{document.querySelector('#timeline').scrollTop=0});
    await frame.locator('#close').click();const text=`收起期间的新消息 ${viewport.width}`;incoming(firstSession,text);
    await frame.locator('#badge').waitFor({state:'visible',timeout:10000});await openChat(frame);
    await frame.getByText(text,{exact:true}).waitFor();
    await frame.waitForFunction(()=>{const t=document.querySelector('#timeline');return t.clientHeight>0&&t.scrollHeight-t.scrollTop-t.clientHeight<=1});
    await page.screenshot({path:`${screenshots}/reopened-${viewport.width}.png`});
  }
  await page.setViewportSize({width:1280,height:850});
  const other=await context.newPage();await other.goto(hosts[1].url);const otherFrame=await frameFor(other);await openChat(otherFrame);assert.equal(await otherFrame.getByText("第一条匿名消息",{exact:true}).count(),0);
  await startChat(otherFrame,"第二个网站的访客");await other.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(":started")));assert.equal(sessions.size,2);
  await page.evaluate(({apiUrl,id})=>{const script=document.createElement('script');script.src=apiUrl+'/livechat/embed.js';script.dataset.channel=id;document.body.append(script)},{apiUrl:api.url,id:secondChannel});
  await page.waitForFunction(id=>Boolean(document.querySelector(`script[data-channel="${id}"]`)),secondChannel);
  let secondFrame;for(let i=0;i<50;i++){secondFrame=page.frames().find(f=>f.url().includes(secondChannel)&&f.url().endsWith('/widget'));if(secondFrame)break;await page.waitForTimeout(100)}assert.ok(secondFrame);
  await secondFrame.locator('#launcher').waitFor({state:'visible'});assert.equal(await secondFrame.locator('#panel').isVisible(),false,'不同渠道不共享展开状态');
  assert.equal(await secondFrame.locator('#draft').getAttribute('placeholder'),'Type a message...');
  await openChat(secondFrame);assert.equal(await secondFrame.getByText('第一条匿名消息',{exact:true}).count(),0);
  await assertWindowControls(page,secondFrame,'left-position');
  assert.equal(await secondFrame.locator('#start').textContent(),'Start chat');
  await startChat(secondFrame,'独立渠道的访客');
  await page.waitForFunction(()=>Object.keys(localStorage).filter(k=>k.endsWith(':started')).length===2);assert.equal(sessions.size,3);
  // 邮件未配置不能影响普通发送；确认丢失并刷新后仍使用相同结束请求 ID。
  widgetLanguage='en';await other.reload();let endFrame=await frameFor(other);await openChat(endFrame);
  endError='email_provider_not_configured';await endFrame.locator('#end').click();
  await endFrame.locator('#confirmAction').click();
  await endFrame.getByText('Email delivery is not configured. Your chat is still open. Please contact support.',{exact:true}).waitFor();
  assert.equal(await endFrame.locator('#form').isVisible(),true);
  await endFrame.locator('#draft').fill('Still able to send');await endFrame.locator('#send').click();
  await endFrame.getByText('Still able to send',{exact:true}).waitFor();
  await endFrame.waitForFunction(()=>!document.querySelector('#end').disabled);
  endError='';dropEndResponse=true;await endFrame.locator('#end').click();
  await endFrame.locator('#confirmAction').click();
  await endFrame.getByText('Could not send. Please retry',{exact:true}).waitFor();
  const retryEndId=endRequests.at(-1).clientRequestId;
  await other.reload();endFrame=await frameFor(other);await openChat(endFrame);
  await endFrame.locator('#end').click();
  await endFrame.locator('#confirmAction').click();
  await endFrame.getByText('Chat ended. Your transcript is queued for email delivery.',{exact:true}).waitFor();
  assert.equal(endRequests.at(-1).clientRequestId,retryEndId);assert.equal(endRequests.at(-1).sendTranscript,true);assert.equal(transcripts.size,1);
  assert.equal(await endFrame.locator('#form').isVisible(),false);assert.equal(await endFrame.locator('#prechat').isVisible(),false);
  await other.reload();endFrame=await frameFor(other);await openChat(endFrame);
  await endFrame.getByText('Still able to send',{exact:true}).waitFor();
  assert.equal(await endFrame.locator('#form').isVisible(),false);assert.equal(await endFrame.locator('#prechat').isVisible(),false);
  await other.screenshot({path:`${screenshots}/ended-english.png`});
  const originalSession=transcripts.values().next().value,originalMessages=sessions.get(originalSession),profileCount=profiles.length,sessionCount=sessions.size;
  const credentialKey=`relaydesk.livechat:${api.url}:${channel}`;
  const originalCredential=await other.evaluate(key=>localStorage.getItem(key),credentialKey);
  await endFrame.locator('#restart').click();
  const unavailableHistory=route=>route.request().method()==='GET'?route.fulfill({status:503,contentType:'application/json',headers:{'access-control-allow-origin':hosts[1].url},body:JSON.stringify({error:'temporary_history_failure'})}):route.continue();
  await other.route('**/messages*',unavailableHistory);
  await endFrame.locator('#confirmAction').click();
  await endFrame.getByText('Could not send. Please retry',{exact:true}).waitFor();
  await endFrame.waitForFunction(()=>!document.querySelector('#restart').disabled);
  assert.equal(await other.evaluate(key=>localStorage.getItem(key),credentialKey),originalCredential,'临时网络错误不能更换访客身份');
  assert.equal(await endFrame.locator('#form').isVisible(),false,'重启失败时维持原结束状态');
  await other.unroute('**/messages*',unavailableHistory);
  await endFrame.locator('#restart').click();await endFrame.locator('#confirmAction').click();await endFrame.locator('#form').waitFor({state:'visible'});
  assert.equal(await endFrame.locator('#prechat').isVisible(),false,'已有身份重启时无需填写资料');
  assert.equal(await endFrame.locator('.message').count(),0,'新聊天不显示旧消息');
  assert.equal(await other.evaluate(key=>localStorage.getItem(key),credentialKey),originalCredential,'继续使用原访客凭证');
  await other.reload();endFrame=await frameFor(other);await openChat(endFrame);
  await endFrame.locator('#form').waitFor({state:'visible'});
  await other.waitForLoadState('networkidle');
  assert.equal(await endFrame.locator('.message').count(),0,'尚未发新消息时刷新也不恢复旧历史');
  assert.equal(await endFrame.locator('#prechat').isVisible(),false);
  await other.goto(hosts[1].url+'/another-page');endFrame=await frameFor(other);await openChat(endFrame);
  await endFrame.locator('#form').waitFor({state:'visible'});await other.waitForLoadState('networkidle');
  assert.equal(await endFrame.locator('.message').count(),0,'跨页面保持新聊天的展示分界');
  await endFrame.locator('#draft').fill('New chat after transcript');await endFrame.locator('#send').click();
  await endFrame.getByText('New chat after transcript',{exact:true}).waitFor();
  await endFrame.waitForFunction(()=>!document.querySelector('#end').disabled);
  assert.equal(profiles.length,profileCount,'不重复创建客户或提交资料');assert.equal(sessions.size,sessionCount);
  assert.ok(originalMessages.some(m=>m.text_content==='Still able to send'),'后台保留旧消息');
  assert.ok(originalMessages.some(m=>m.text_content==='New chat after transcript'),'新消息仍归属原客户');
  assert.equal(transcripts.size,1);
  // 新周期超过一页时，向前分页不能穿透到上一段聊天。
  for(let index=0;index<105;index++)incoming(originalMessages,`New cycle reply ${index}`);
  await other.reload();endFrame=await frameFor(other);await openChat(endFrame);
  await endFrame.getByText('New cycle reply 104',{exact:true}).waitFor();
  await endFrame.locator('#older').click();await endFrame.getByText('New chat after transcript',{exact:true}).waitFor();
  assert.equal(await endFrame.getByText('Still able to send',{exact:true}).count(),0);
  assert.equal(await endFrame.locator('#older').isVisible(),false,'到达展示分界后停止历史分页');
  await other.screenshot({path:`${screenshots}/restarted-existing-visitor.png`});
  await endFrame.locator('#endOnly').click();await endFrame.locator('#confirmAction').click();await endFrame.getByText('Chat ended.',{exact:true}).waitFor();
  assert.equal(endRequests.at(-1).sendTranscript,false);assert.equal(closedChats.size,1);assert.equal(transcripts.size,1);
  await endFrame.locator('#restart').click();await endFrame.locator('#confirmAction').click();await endFrame.locator('#form').waitFor({state:'visible'});
  assert.equal(await endFrame.locator('.message').count(),0,'普通 End chat 后同样开始空白新聊天');
  incoming(originalMessages,'Support in latest chat');
  await endFrame.getByText('Support in latest chat',{exact:true}).waitFor();
  assert.equal(await endFrame.getByText('New chat after transcript',{exact:true}).count(),0);
  assert.equal(profiles.length,profileCount);
  expiredSessions.add(originalSession);
  await endFrame.getByText('Chat expired. Support retains the history. You can start a new chat',{exact:true}).waitFor();
  await endFrame.locator('#restart').click();await endFrame.locator('#confirmAction').click();await endFrame.locator('#prechat').waitFor({state:'visible'});
  await endFrame.locator('#restart').waitFor({state:'hidden'});
  assert.notEqual(await other.evaluate(key=>localStorage.getItem(key),credentialKey),originalCredential,'只有失效凭证才生成新身份');
  await startChat(endFrame,'Fresh identity after expiry');
  assert.equal(profiles.length,profileCount+1);assert.ok(originalMessages.some(m=>m.text_content==='Still able to send'));
  widgetLanguage=undefined;
  const mobileContext=await browser.newContext({viewport:{width:375,height:740},...(browserType===firefox?{}:{isMobile:true}),hasTouch:true}),mobile=await mobileContext.newPage();mobile.on("pageerror",error=>errors.push(error.message));
  await mobile.goto(hosts[0].url);const mobileFrame=await frameFor(mobile);await openChat(mobileFrame);
  await assertWindowControls(mobile,mobileFrame,'mobile');
  await mobile.screenshot({path:`${screenshots}/mobile-prechat.png`});
  await mobile.setViewportSize({width:320,height:460});await mobileFrame.locator('#start').scrollIntoViewIfNeeded();await mobile.screenshot({path:`${screenshots}/mobile-compact-prechat.png`});
  await assertWindowControls(mobile,mobileFrame,'mobile-compact');
  assert.equal(await mobileFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await startChat(mobileFrame,"手机端消息");await mobile.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(":started")));await mobile.setViewportSize({width:375,height:740});
  await assertMessageLayout(mobileFrame);
  const bounds=await mobileFrame.locator("#panel").boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=375&&bounds.y+bounds.height<=740);
  assert.equal(await mobileFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await mobile.screenshot({path:`${screenshots}/mobile.png`});await mobile.setViewportSize({width:320,height:460});
  assert.equal(await mobileFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await mobile.screenshot({path:`${screenshots}/mobile-compact.png`});
  await assertMessageLayout(mobileFrame);
  await assertReplyLayout(mobileFrame);
  await mobile.screenshot({path:`${screenshots}/mobile-compact-reply.png`});
  await mobileFrame.locator('#replyBar button').click();await mobileFrame.locator('#replyBar').waitFor({state:'hidden'});
  const localized=[['zh-CN','请输入消息...','发送','您好，有什么可以帮助您？','附件不能超过 10 MB'],['zh-TW','請輸入訊息...','傳送','您好，有什麼可以幫助您？','附件不能超過 10 MB'],['en','Type a message...','Send','Hi! How can we help you?','Attachments must be 10 MB or smaller'],['ja','メッセージを入力...','送信','こんにちは。どのようなご用件でしょうか？','添付は10 MB以下にしてください'],['es','Escribe un mensaje...','Enviar','¡Hola! ¿Cómo podemos ayudarte?','El archivo no puede superar 10 MB'],['pt','Digite uma mensagem...','Enviar','Olá! Como podemos ajudar?','O anexo não pode exceder 10 MB']];
  for(const [language,placeholder,send,welcome,tooLarge] of localized){
    widgetLanguage=language;await mobile.reload();const localizedFrame=await frameFor(mobile);await openChat(localizedFrame);
    assert.equal(await localizedFrame.locator('html').getAttribute('lang'),language);
    assert.equal(await localizedFrame.locator('#draft').getAttribute('placeholder'),placeholder);
    assert.equal(await localizedFrame.locator('#send').getAttribute('aria-label'),send);
    assert.equal(await localizedFrame.locator('#welcome').textContent(),welcome);
    await localizedFrame.locator('#file').setInputFiles({name:'large.txt',mimeType:'text/plain',buffer:Buffer.alloc(10485761)});
    await localizedFrame.getByText(tooLarge,{exact:true}).waitFor();
    assert.equal(await localizedFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(language==='en')await mobile.screenshot({path:`${screenshots}/mobile-english.png`});
  }
  for(const language of [null,'invalid']){
    widgetLanguage=language;await mobile.reload();const defaultFrame=await frameFor(mobile);await openChat(defaultFrame);
    assert.equal(await defaultFrame.locator('html').getAttribute('lang'),'en');
    assert.equal(await defaultFrame.locator('#draft').getAttribute('placeholder'),'Type a message...');
    assert.equal(await defaultFrame.locator('#welcome').textContent(),'Hi! How can we help you?');
  }
  widgetLanguage='en';await page.reload();const englishFrame=await frameFor(page);await openChat(englishFrame);
  failNext=true;await englishFrame.locator('#draft').fill('Retry in English');await englishFrame.locator('#send').click();await englishFrame.getByText('Failed. Click to retry',{exact:true}).waitFor();
  assert.equal(await englishFrame.locator('#notice').textContent(),'Could not send. Please retry');
  await page.screenshot({path:`${screenshots}/desktop-english.png`});
  // 校验渠道首字母、自定义图标、失败回退和清除后的行为。
  widgetName='  BelaroPrecision';await page.reload();let brandFrame=await frameFor(page);await openChat(brandFrame);
  assert.equal(await brandFrame.locator('#avatar').textContent(),'B');
  await page.route('https://icons.example.test/**',route=>route.request().url().endsWith('brand.png')?route.fulfill({contentType:'image/png',body:testPng}):route.fulfill({status:404,body:''}));
  widgetIcon='https://icons.example.test/brand.png';await page.reload();brandFrame=await frameFor(page);await openChat(brandFrame);
  await brandFrame.waitForFunction(()=>document.querySelector('#avatar img')?.naturalWidth>0);
  await brandFrame.waitForFunction(()=>[...document.querySelectorAll('.support-avatar')].length>0&&[...document.querySelectorAll('.support-avatar')].every(avatar=>avatar.querySelector('img')?.naturalWidth>0));
  assert.equal(await brandFrame.locator('.support-avatar img').first().getAttribute('src'),widgetIcon);
  await assertMessageLayout(brandFrame);
  assert.equal(await brandFrame.locator('#avatar img').getAttribute('referrerpolicy'),'no-referrer');
  const avatarBounds=await brandFrame.locator('#avatar').boundingBox();assert.equal(avatarBounds.width,38);assert.equal(avatarBounds.height,38);
  await page.screenshot({path:`${screenshots}/desktop-custom-icon.png`});
  await page.setViewportSize({width:320,height:460});await page.screenshot({path:`${screenshots}/mobile-custom-icon.png`});
  assert.equal(await brandFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  widgetIcon='https://icons.example.test/missing.png';await page.reload();brandFrame=await frameFor(page);await openChat(brandFrame);await page.waitForLoadState('networkidle');
  assert.equal(await brandFrame.locator('#avatar').textContent(),'B');assert.equal(await brandFrame.locator('#avatar img').count(),0);
  assert.equal(await brandFrame.locator('.support-avatar').first().textContent(),'B');
  widgetIcon='';widgetName='<Brand>';await page.reload();brandFrame=await frameFor(page);
  assert.equal(await brandFrame.locator('#avatar').textContent(),'<');assert.equal(await brandFrame.locator('#avatar').locator('*').count(),0);
  widgetName='';await page.reload();brandFrame=await frameFor(page);assert.equal(await brandFrame.locator('#avatar').textContent(),'?');
  assert.deepEqual(errors,[]);console.log(`已通过：双站点及多渠道隔离、重复嵌入、样式隔离、匿名消息、坐席回复、刷新恢复、失败重试、确认丢失恢复、未读、多页历史与断线补齐、附件预览上传下载、图片内联预览、表情发送、六种界面语言及桌面/移动布局、独立结束会话、结束并发送记录、邮件错误隔离、确认丢失后的幂等重试及结束后刷新恢复。截图：${screenshots}`);
}catch(error){console.error({errors,sessions:[...sessions.values()]});if(debugPage){const frame=debugPage.frames().find(f=>f.url().endsWith("/widget"));console.error(await frame?.locator("body").innerText());await debugPage.screenshot({path:`${screenshots}/failure.png`})}throw error}
finally{await browser.close();await rm(uploadFixtureDir,{recursive:true,force:true});await Promise.all([api,...hosts].map(({server})=>new Promise(resolve=>server.close(resolve))))}
