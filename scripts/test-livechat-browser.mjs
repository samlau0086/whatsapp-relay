// 本脚本使用真实嵌入资源与模拟 API，不替代 PostgreSQL、对象存储和 AI 的部署验收。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {randomUUID} from "node:crypto";
import {mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {chromium} from "playwright";
import {livechatLoader,livechatWidget} from "../services/api/dist/livechat-widget.js";

const channel="11111111-1111-4111-8111-111111111111";
const secondChannel="22222222-2222-4222-8222-222222222222";
const sessions=new Map(),uploads=new Map(),origins=new Set(),errors=[],profiles=[];
const transcripts=new Map(),closedChats=new Map(),endRequests=[];
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
    const bytes=await body(req),text=bytes.toString("latin1"),id=randomUUID(),start=bytes.indexOf(Buffer.from("\r\n\r\n"))+4,end=bytes.lastIndexOf(Buffer.from("\r\n--"));
    uploads.set(id,{name:/filename="([^"]+)"/.exec(text)?.[1]||"attachment",mime:/Content-Type: ([^\r\n]+)/i.exec(text)?.[1]||"application/octet-stream",bytes:bytes.subarray(start,end)});json(201,{id});return;
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
const browser=await chromium.launch({headless:true});
const screenshots=fileURLToPath(new URL("../outputs/livechat/",import.meta.url));await mkdir(screenshots,{recursive:true});
const frameFor=async page=>{await page.waitForFunction(()=>document.querySelector('div')?.shadowRoot===null);for(let i=0;i<50;i++){const frame=page.frames().find(f=>f.url().endsWith("/widget"));if(frame){await frame.locator("#launcher").waitFor({state:"visible"});return frame}await page.waitForTimeout(100)}throw Error("窗口未加载")};
const incoming=(messages,text)=>messages.push({id:randomUUID(),direction:"out",text_content:text,created_at:timestamp()});
const assertMessageLayout=async frame=>{
  const result=await frame.evaluate(()=>{
    const rows=[...document.querySelectorAll('.message')];
    return rows.every(row=>{
      const avatar=row.querySelector('.message-avatar'),bubble=row.querySelector('.bubble'),reply=row.querySelector('.reply-message');
      if(!avatar||!bubble)return false;
      const a=avatar.getBoundingClientRect(),b=bubble.getBoundingClientRect(),r=reply?.getBoundingClientRect();
      return a.right<=b.left&&(!r||(r.left>=b.right&&getComputedStyle(reply).opacity==='1'))&&
        (!row.classList.contains('out')||avatar.textContent==='Me');
    })&&rows.length>0&&document.querySelector('#composerTools').getBoundingClientRect().bottom<=document.querySelector('#draft').getBoundingClientRect().top;
  });
  assert.equal(result,true,'头像应在气泡左边，回复按钮在右边，工具栏在输入框上方');
};
const startChat=async(frame,text)=>{
  await frame.locator('#visitorName').fill('Sam');await frame.locator('#email').fill('sam@example.com');
  await frame.locator('#company').fill('Example Ltd');await frame.locator('#whatsapp').fill('+12025550123');
  await frame.locator('#initialMessage').fill(text);await frame.locator('#start').click();
  await frame.locator('#form').waitFor({state:'visible'});
};
let debugPage;
try{
  const context=await browser.newContext({viewport:{width:1280,height:850}}),page=await context.newPage();
  debugPage=page;
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto(hosts[0].url);let frame=await frameFor(page);
  await frame.locator("#launcher").click();
  await frame.locator('#start').click();assert.equal(sessions.size,0);
  assert.equal(await frame.locator('#visitorName').getAttribute('required'),'');
  await page.screenshot({path:`${screenshots}/desktop-prechat.png`});
  failNext=true;
  await frame.locator('#visitorName').fill('Sam');await frame.locator('#email').fill('sam@example.com');await frame.locator('#company').fill('Example Ltd');await frame.locator('#whatsapp').fill('+12025550123');await frame.locator('#initialMessage').fill('第一条匿名消息');await frame.locator('#start').click();
  await frame.getByText('发送失败，点击重试').waitFor();await page.reload();frame=await frameFor(page);await frame.locator('#launcher').click();await frame.getByText('发送失败，点击重试').click();
  await frame.getByText("第一条匿名消息",{exact:true}).waitFor();await frame.locator("#send").waitFor({state:"visible"});
  await page.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(":started")));
  const firstSession=[...sessions.values()][0];assert.equal(firstSession.length,1);
  assert.equal(profiles[0].name,'Sam');assert.equal(profiles[0].email,'sam@example.com');assert.equal(profiles[0].company,'Example Ltd');assert.equal(profiles[0].whatsapp,'+12025550123');
  assert.ok(profiles[0].context.browserLanguage);assert.ok(profiles[0].context.timeZone);assert.equal(profiles[0].context.pageUrl,hosts[0].url+'/');
  incoming(firstSession,"坐席回复已送达");await frame.getByText("坐席回复已送达",{exact:true}).waitFor({timeout:10000});
  await assertMessageLayout(frame);
  assert.equal(await frame.locator('.support-avatar').first().textContent(),await frame.locator('#avatar').textContent());
  await frame.locator('.message.in .reply-message').first().click();await frame.locator('#replyBar').waitFor({state:'visible'});
  await frame.locator('#replyBar button').click();await frame.locator('#replyBar').waitFor({state:'hidden'});
  await page.screenshot({path:`${screenshots}/desktop.png`});
  await page.evaluate(()=>{const original=document.querySelector('script[data-channel]'),copy=document.createElement('script');copy.src=original.src;copy.dataset.channel=original.dataset.channel;document.body.append(copy)});
  await page.waitForLoadState("networkidle");assert.equal(page.frames().filter(f=>f.url().endsWith("/widget")).length,1);
  await page.evaluate(()=>{const key=Object.keys(localStorage).find(k=>k.endsWith(':outbox')),messageId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';localStorage.setItem(key,JSON.stringify({[messageId]:{text:'已接收但确认丢失'}}))});
  firstSession.push({id:randomUUID(),client_message_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',direction:'in',text_content:'已接收但确认丢失',created_at:timestamp()});
  await page.reload();frame=await frameFor(page);await frame.locator("#launcher").click();await frame.getByText("第一条匿名消息",{exact:true}).waitFor();
  await page.waitForFunction(()=>Object.keys(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(':outbox')))||'{}')).length===0);
  failNext=true;await frame.locator("#draft").fill("刷新后重试");await frame.locator("#send").click();await frame.getByText("发送失败，点击重试").waitFor();
  await page.reload();frame=await frameFor(page);await frame.locator("#launcher").click();await frame.getByText("发送失败，点击重试").click();
  await page.waitForFunction(()=>Object.keys(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.endsWith(":outbox")))||"{}")).length===0);
  assert.equal(firstSession.filter(m=>m.text_content==="刷新后重试").length,1);
  await frame.locator("#close").click();incoming(firstSession,"未读回复");await frame.locator("#badge").waitFor({state:"visible",timeout:10000});await frame.locator("#launcher").click();assert.equal(await frame.locator("#badge").isVisible(),false);
  await context.setOffline(true);incoming(firstSession,"断线期间回复");await page.waitForTimeout(4200);await context.setOffline(false);await frame.getByText("断线期间回复",{exact:true}).waitFor({timeout:12000});
  assert.equal(await frame.locator('#emoji svg,#image svg,#attach svg,#send svg').count(),4);
  await frame.locator("#file").setInputFiles({name:"remove.txt",mimeType:"text/plain",buffer:Buffer.from("remove")});await frame.locator('#composerPreview').getByText("remove.txt",{exact:true}).waitFor();await frame.locator('#composerPreview').getByRole('button',{name:'移除附件'}).click();await frame.locator('#composerPreview').waitFor({state:'hidden'});
  await frame.locator("#file").setInputFiles({name:"sample.txt",mimeType:"text/plain",buffer:Buffer.from("test")});await frame.locator('#composerPreview').getByText("sample.txt",{exact:true}).waitFor();
  await frame.locator('#draft').fill('附件说明');await frame.locator('#send').click();await frame.locator('#composerPreview').waitFor({state:'hidden'});await frame.getByRole('button',{name:'sample.txt',exact:true}).waitFor();
  const download=page.waitForEvent("download");await frame.getByRole("button",{name:"sample.txt",exact:true}).click();assert.equal((await download).suggestedFilename(),"sample.txt");
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAAAASUVORK5CYII=','base64');
  await frame.locator('#image').click();await frame.locator('#file').setInputFiles({name:'preview.png',mimeType:'image/png',buffer:png});await frame.locator('#composerPreview img').waitFor();
  await frame.locator('#emoji').click();await frame.locator('#emojiPanel button').first().click();assert.ok((await frame.locator('#draft').inputValue()).length>0);
  await frame.locator('#send').click();const sentImage=frame.locator('.attachment-image img[alt="preview.png"]');await sentImage.waitFor();await sentImage.click();await frame.locator('dialog.image-preview').waitFor();await page.screenshot({path:`${screenshots}/desktop-media-preview.png`});await frame.locator('dialog.image-preview').getByText('取消',{exact:true}).click();
  for(let i=0;i<205;i++)incoming(firstSession,`分页回复 ${i}`);
  await frame.getByText('分页回复 204',{exact:true}).waitFor({timeout:15000});
  await page.reload();frame=await frameFor(page);await frame.locator('#launcher').click();await frame.getByText('分页回复 204',{exact:true}).waitFor();
  await frame.locator('#older').click();await frame.getByText('分页回复 5',{exact:true}).waitFor();await frame.locator('#older').click();await frame.getByText('第一条匿名消息',{exact:true}).waitFor();
  const other=await context.newPage();await other.goto(hosts[1].url);const otherFrame=await frameFor(other);await otherFrame.locator("#launcher").click();assert.equal(await otherFrame.getByText("第一条匿名消息",{exact:true}).count(),0);
  await startChat(otherFrame,"第二个网站的访客");await other.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(":started")));assert.equal(sessions.size,2);
  await page.evaluate(({apiUrl,id})=>{const script=document.createElement('script');script.src=apiUrl+'/livechat/embed.js';script.dataset.channel=id;document.body.append(script)},{apiUrl:api.url,id:secondChannel});
  await page.waitForFunction(id=>Boolean(document.querySelector(`script[data-channel="${id}"]`)),secondChannel);
  await page.waitForLoadState('networkidle');
  let secondFrame;for(let i=0;i<50;i++){secondFrame=page.frames().find(f=>f.url().includes(secondChannel)&&f.url().endsWith('/widget'));if(secondFrame)break;await page.waitForTimeout(100)}assert.ok(secondFrame);
  await secondFrame.locator('#launcher').waitFor({state:'visible'});
  assert.equal(await secondFrame.locator('#draft').getAttribute('placeholder'),'Type a message...');
  await secondFrame.locator('#launcher').click();assert.equal(await secondFrame.getByText('第一条匿名消息',{exact:true}).count(),0);
  assert.equal(await secondFrame.locator('#start').textContent(),'Start chat');
  await startChat(secondFrame,'独立渠道的访客');
  await page.waitForFunction(()=>Object.keys(localStorage).filter(k=>k.endsWith(':started')).length===2);assert.equal(sessions.size,3);
  // 邮件未配置不能影响普通发送；确认丢失并刷新后仍使用相同结束请求 ID。
  widgetLanguage='en';await other.reload();let endFrame=await frameFor(other);await endFrame.locator('#launcher').click();
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
  await other.reload();endFrame=await frameFor(other);await endFrame.locator('#launcher').click();
  await endFrame.locator('#end').click();
  await endFrame.locator('#confirmAction').click();
  await endFrame.getByText('Chat ended. Your transcript is queued for email delivery.',{exact:true}).waitFor();
  assert.equal(endRequests.at(-1).clientRequestId,retryEndId);assert.equal(endRequests.at(-1).sendTranscript,true);assert.equal(transcripts.size,1);
  assert.equal(await endFrame.locator('#form').isVisible(),false);assert.equal(await endFrame.locator('#prechat').isVisible(),false);
  await other.reload();endFrame=await frameFor(other);await endFrame.locator('#launcher').click();
  await endFrame.getByText('Still able to send',{exact:true}).waitFor();
  assert.equal(await endFrame.locator('#form').isVisible(),false);assert.equal(await endFrame.locator('#prechat').isVisible(),false);
  await other.screenshot({path:`${screenshots}/ended-english.png`});
  await endFrame.locator('#restart').click();await endFrame.locator('#confirmAction').click();await endFrame.locator('#prechat').waitFor({state:'visible'});
  await startChat(endFrame,'New chat after transcript');assert.equal(transcripts.size,1);
  await endFrame.locator('#endOnly').click();await endFrame.locator('#confirmAction').click();await endFrame.getByText('Chat ended.',{exact:true}).waitFor();
  assert.equal(endRequests.at(-1).sendTranscript,false);assert.equal(closedChats.size,1);assert.equal(transcripts.size,1);
  widgetLanguage=undefined;
  const mobileContext=await browser.newContext({viewport:{width:375,height:740},isMobile:true,hasTouch:true}),mobile=await mobileContext.newPage();mobile.on("pageerror",error=>errors.push(error.message));
  await mobile.goto(hosts[0].url);const mobileFrame=await frameFor(mobile);await mobileFrame.locator("#launcher").click();
  await mobile.screenshot({path:`${screenshots}/mobile-prechat.png`});
  await mobile.setViewportSize({width:320,height:460});await mobileFrame.locator('#start').scrollIntoViewIfNeeded();await mobile.screenshot({path:`${screenshots}/mobile-compact-prechat.png`});
  assert.equal(await mobileFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await startChat(mobileFrame,"手机端消息");await mobile.waitForFunction(()=>Object.keys(localStorage).some(k=>k.endsWith(":started")));await mobile.setViewportSize({width:375,height:740});
  await assertMessageLayout(mobileFrame);
  const bounds=await mobileFrame.locator("#panel").boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=375&&bounds.y+bounds.height<=740);
  assert.equal(await mobileFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await mobile.screenshot({path:`${screenshots}/mobile.png`});await mobile.setViewportSize({width:320,height:460});
  assert.equal(await mobileFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await mobile.screenshot({path:`${screenshots}/mobile-compact.png`});
  await assertMessageLayout(mobileFrame);
  const localized=[['zh-CN','请输入消息...','发送','您好，有什么可以帮助您？','附件不能超过 10 MB'],['zh-TW','請輸入訊息...','傳送','您好，有什麼可以幫助您？','附件不能超過 10 MB'],['en','Type a message...','Send','Hi! How can we help you?','Attachments must be 10 MB or smaller'],['ja','メッセージを入力...','送信','こんにちは。どのようなご用件でしょうか？','添付は10 MB以下にしてください'],['es','Escribe un mensaje...','Enviar','¡Hola! ¿Cómo podemos ayudarte?','El archivo no puede superar 10 MB'],['pt','Digite uma mensagem...','Enviar','Olá! Como podemos ajudar?','O anexo não pode exceder 10 MB']];
  for(const [language,placeholder,send,welcome,tooLarge] of localized){
    widgetLanguage=language;await mobile.reload();const localizedFrame=await frameFor(mobile);await localizedFrame.locator('#launcher').click();
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
    widgetLanguage=language;await mobile.reload();const defaultFrame=await frameFor(mobile);await defaultFrame.locator('#launcher').click();
    assert.equal(await defaultFrame.locator('html').getAttribute('lang'),'en');
    assert.equal(await defaultFrame.locator('#draft').getAttribute('placeholder'),'Type a message...');
    assert.equal(await defaultFrame.locator('#welcome').textContent(),'Hi! How can we help you?');
  }
  widgetLanguage='en';await page.reload();const englishFrame=await frameFor(page);await englishFrame.locator('#launcher').click();
  failNext=true;await englishFrame.locator('#draft').fill('Retry in English');await englishFrame.locator('#send').click();await englishFrame.getByText('Failed. Click to retry',{exact:true}).waitFor();
  assert.equal(await englishFrame.locator('#notice').textContent(),'Could not send. Please retry');
  await page.screenshot({path:`${screenshots}/desktop-english.png`});
  // 校验渠道首字母、自定义图标、失败回退和清除后的行为。
  widgetName='  BelaroPrecision';await page.reload();let brandFrame=await frameFor(page);await brandFrame.locator('#launcher').click();
  assert.equal(await brandFrame.locator('#avatar').textContent(),'B');
  await page.route('https://icons.example.test/**',route=>route.request().url().endsWith('brand.png')?route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDAAAAAAASUVORK5CYII=','base64')}):route.fulfill({status:404,body:''}));
  widgetIcon='https://icons.example.test/brand.png';await page.reload();brandFrame=await frameFor(page);await brandFrame.locator('#launcher').click();
  await brandFrame.waitForFunction(()=>document.querySelector('#avatar img')?.naturalWidth>0);
  await brandFrame.waitForFunction(()=>[...document.querySelectorAll('.support-avatar')].length>0&&[...document.querySelectorAll('.support-avatar')].every(avatar=>avatar.querySelector('img')?.naturalWidth>0));
  assert.equal(await brandFrame.locator('.support-avatar img').first().getAttribute('src'),widgetIcon);
  await assertMessageLayout(brandFrame);
  assert.equal(await brandFrame.locator('#avatar img').getAttribute('referrerpolicy'),'no-referrer');
  const avatarBounds=await brandFrame.locator('#avatar').boundingBox();assert.equal(avatarBounds.width,38);assert.equal(avatarBounds.height,38);
  await page.screenshot({path:`${screenshots}/desktop-custom-icon.png`});
  await page.setViewportSize({width:320,height:460});await page.screenshot({path:`${screenshots}/mobile-custom-icon.png`});
  assert.equal(await brandFrame.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  widgetIcon='https://icons.example.test/missing.png';await page.reload();brandFrame=await frameFor(page);await brandFrame.locator('#launcher').click();await page.waitForLoadState('networkidle');
  assert.equal(await brandFrame.locator('#avatar').textContent(),'B');assert.equal(await brandFrame.locator('#avatar img').count(),0);
  assert.equal(await brandFrame.locator('.support-avatar').first().textContent(),'B');
  widgetIcon='';widgetName='<Brand>';await page.reload();brandFrame=await frameFor(page);
  assert.equal(await brandFrame.locator('#avatar').textContent(),'<');assert.equal(await brandFrame.locator('#avatar').locator('*').count(),0);
  widgetName='';await page.reload();brandFrame=await frameFor(page);assert.equal(await brandFrame.locator('#avatar').textContent(),'?');
  assert.deepEqual(errors,[]);console.log(`已通过：双站点及多渠道隔离、重复嵌入、样式隔离、匿名消息、坐席回复、刷新恢复、失败重试、确认丢失恢复、未读、多页历史与断线补齐、附件预览上传下载、图片内联预览、表情发送、六种界面语言及桌面/移动布局、独立结束会话、结束并发送记录、邮件错误隔离、确认丢失后的幂等重试及结束后刷新恢复。截图：${screenshots}`);
}catch(error){console.error({errors,sessions:[...sessions.values()]});if(debugPage){const frame=debugPage.frames().find(f=>f.url().endsWith("/widget"));console.error(await frame?.locator("body").innerText());await debugPage.screenshot({path:`${screenshots}/failure.png`})}throw error}
finally{await browser.close();await Promise.all([api,...hosts].map(({server})=>new Promise(resolve=>server.close(resolve))))}
