// 使用真实设置组件和编译后的全局样式；API 全部模拟，不修改业务渠道。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir,readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import {chromium} from "playwright";

const require=createRequire(new URL("../services/api/package.json",import.meta.url));
const {build}=require("esbuild");
const root=fileURLToPath(new URL("..",import.meta.url));
const entry=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {LivechatSettingsPanel} from './app/livechat-settings';
const noop=()=>{};
createRoot(document.getElementById('root')).render(<LivechatSettingsPanel token="fixture" onToken={noop} onToast={noop} onAccountsChanged={noop}/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_RELAY_API_URL":'""'}});
const css=(await postcss([tailwindcss()]).process(await readFile(resolve(root,"app/globals.css"),"utf8"),{from:resolve(root,"app/globals.css")})).css+await readFile(resolve(root,"app/ui/ui.css"),"utf8");
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else{response.setHeader("content-type","text/html");response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script></html>`);}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
let browser;
try{
  browser=await chromium.launch({headless:true});
  const output=resolve(root,"outputs/livechat-settings");await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568},{width:844,height:390}]){
    const page=await browser.newPage({viewport});
    const errors=[],writes=[];let failSave=false;
    page.on("pageerror",error=>errors.push(error.message));
    let channel={id:"test-channel",display_name:"BelaroPrecision",public_id:"public-id",welcome_message:"How can I help you?",icon_url:"",theme_color:"#000000",position:"right",language:"en",allowed_origins:["https://belaroprecision.com"],enabled:true};
    await page.route("**/api/v1/admin/livechat/channels**",async route=>{
      const request=route.request();
      if(request.method()==="GET")return route.fulfill({json:{data:[channel]}});
      const data=request.postDataJSON();writes.push({method:request.method(),data});
      if(failSave)return route.fulfill({status:400,json:{error:"invalid_origin"}});
      channel={...channel,transcript_template:data.transcriptTemplate,display_name:data.displayName,icon_url:data.iconUrl,welcome_message:data.welcomeMessage,starter_messages:data.starterMessages,theme_color:data.themeColor,position:data.position,language:data.language,allowed_origins:data.allowedOrigins,enabled:data.enabled,ga4_measurement_id:data.ga4MeasurementId,ga4ApiSecretConfigured:Boolean(data.ga4ApiSecret)||channel.ga4ApiSecretConfigured};
      await route.fulfill({json:{data:channel}});
    });
    await page.route("**/api/v1/admin/google-ads",route=>route.fulfill({json:{connected:false,oauthConfigured:false,data:[]}}));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button",{name:"新增渠道",exact:true}).click();
    const dialog=page.getByRole("dialog"),save=dialog.getByRole("button",{name:"保存渠道",exact:true});
    const templateDefaults={subject:await page.getByRole('textbox',{name:'邮件主题',exact:true}).inputValue(),body:await page.getByRole('textbox',{name:'邮件正文',exact:true}).inputValue(),message:await page.getByRole('textbox',{name:'单条消息格式',exact:true}).inputValue(),departmentName:''};
    assert.equal(templateDefaults.subject,'Your LiveChat transcript');assert.ok(templateDefaults.body.includes('{{messages}}'));assert.ok(templateDefaults.message.includes('{{message.attachments}}'));
    await assertLayout("create");
    assert.equal(await page.getByLabel("渠道名称",{exact:true}).evaluate(el=>el===document.activeElement),true);
    assert.equal(await page.getByLabel("访客界面语言",{exact:true}).inputValue(),"en");
    await save.click();assert.equal(writes.length,0);
    await page.getByLabel("渠道名称",{exact:true}).fill("新网站客服");
    await page.locator("#livechat-origins").fill("https://example.com\nhttps://shop.example.com");
    await page.getByLabel("访客界面语言",{exact:true}).selectOption("zh-CN");
    await page.getByLabel("入口位置",{exact:true}).selectOption("left");
    await save.click();await dialog.waitFor({state:"detached"});
    assert.deepEqual(writes[0],{method:"POST",data:{transcriptTemplate:templateDefaults,displayName:"新网站客服",iconUrl:"",welcomeMessage:"",starterMessages:[],themeColor:"#146d73",position:"left",language:"zh-CN",allowedOrigins:["https://example.com","https://shop.example.com"],enabled:true,ga4MeasurementId:""}});
    await page.getByRole("button",{name:"编辑",exact:true}).click();
    assert.equal(await page.getByLabel("渠道名称",{exact:true}).inputValue(),"新网站客服");
    await page.getByRole('textbox',{name:'客服部门',exact:true}).fill('Sales');
    const subject=page.getByRole('textbox',{name:'邮件主题',exact:true}),body=page.getByRole('textbox',{name:'邮件正文',exact:true}),message=page.getByRole('textbox',{name:'单条消息格式',exact:true});
    await subject.fill('Transcript · ');await subject.evaluate(el=>el.setSelectionRange(el.value.length,el.value.length));
    await page.getByRole('combobox',{name:'插入变量 · 邮件主题',exact:true}).selectOption('visitor.name');
    assert.equal(await subject.inputValue(),'Transcript · {{visitor.name}}');
    await message.fill('{{message.time}} {{message.body}}\n{{message.attachments}}');
    await body.fill('Hello {{visitor.name}} · {{department.name}}\n{{channel.logo}}\n{{messages}}');
    await dialog.getByText('邮件预览（测试数据）',{exact:true}).click();
    const preview=page.frameLocator('iframe[title="会话记录邮件预览"]');
    await preview.getByRole('heading',{name:'Chat History'}).waitFor();
    assert.ok((await preview.locator('body').innerText()).includes('John Smith'));
    assert.ok((await preview.locator('body').innerText()).includes('drawing.step'));
    assert.equal(await preview.locator('body').evaluate(el=>el.scrollWidth>document.documentElement.clientWidth),false);
    await page.locator('iframe[title="会话记录邮件预览"]').screenshot({path:resolve(output,`transcript-preview-${viewport.width}x${viewport.height}.png`)});
    const invalidBody='{{unknown}} {{messages}}';await body.fill(invalidBody);await save.click();assert.equal(writes.length,1);
    await body.fill('Hello {{visitor.name}} · {{department.name}}\n{{channel.logo}}\n{{messages}}');
    const addQuestion=dialog.getByRole('button',{name:'添加问题',exact:true});
    await addQuestion.click();await save.click();assert.equal(writes.length,1,'空问题阻止保存');
    await page.getByRole('textbox',{name:'引导问题 1',exact:true}).fill('如何选择材料？');
    await addQuestion.click();await page.getByRole('textbox',{name:'引导问题 2',exact:true}).fill('我想获取报价');
    await addQuestion.click();await page.getByRole('textbox',{name:'引导问题 3',exact:true}).fill('待删除的问题');
    await dialog.getByRole('button',{name:'删除问题 3',exact:true}).click();
    await dialog.getByRole('button',{name:'上移问题 2',exact:true}).click();
    assert.equal(await page.getByRole('textbox',{name:'引导问题 1',exact:true}).inputValue(),'我想获取报价');
    await dialog.getByRole('button',{name:'下移问题 1',exact:true}).click();
    await page.locator("#livechat-welcome").fill("How can I help you?");
    await page.locator("#livechat-color").fill("#000000");
    await page.locator("#livechat-origins").fill("https://belaroprecision.com");
    await page.locator("#livechat-ga4-id").fill("g-test123");
    await page.locator("#livechat-ga4-secret").fill("fixture-secret_123");
    await assertLayout("edit");
    await save.focus();await page.keyboard.press("Tab");assert.equal(await dialog.getByRole("button",{name:"关闭",exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press("Shift+Tab");assert.equal(await save.evaluate(el=>el===document.activeElement),true);
    failSave=true;await save.click();
    await dialog.getByRole("alert").waitFor();assert.equal(await page.getByRole("alert").count(),1);
    assert.equal(await page.locator("#livechat-welcome").inputValue(),"How can I help you?");
    assert.equal(await page.locator("#livechat-ga4-secret").inputValue(),"fixture-secret_123");
    assert.equal(await page.getByRole('textbox',{name:'引导问题 2',exact:true}).inputValue(),'我想获取报价');
    assert.equal(await subject.inputValue(),'Transcript · {{visitor.name}}');assert.equal(await page.getByRole('textbox',{name:'客服部门',exact:true}).inputValue(),'Sales');
    await assertLayout("error");
    failSave=false;await page.getByLabel("启用渠道",{exact:true}).uncheck();await save.click();await dialog.waitFor({state:"detached"});
    assert.equal(writes.at(-1).method,"PUT");assert.equal(writes.at(-1).data.enabled,false);assert.equal(writes.at(-1).data.themeColor,"#000000");
    assert.equal(writes.at(-1).data.ga4MeasurementId,"G-TEST123");assert.equal(writes.at(-1).data.ga4ApiSecret,"fixture-secret_123");
    assert.deepEqual(writes.at(-1).data.starterMessages,['如何选择材料？','我想获取报价']);
    await page.getByRole("button",{name:"编辑",exact:true}).click();
    assert.equal(await subject.inputValue(),'Transcript · {{visitor.name}}');assert.equal(await page.getByRole('textbox',{name:'客服部门',exact:true}).inputValue(),'Sales');
    assert.equal(writes.at(-1).data.transcriptTemplate.subject,'Transcript · {{visitor.name}}');
    await dialog.getByRole('button',{name:'恢复默认模板',exact:true}).click();assert.equal(await subject.inputValue(),templateDefaults.subject);
    assert.equal(await body.inputValue(),templateDefaults.body);
    assert.equal(await page.locator("#livechat-ga4-id").inputValue(),"G-TEST123");assert.equal(await page.locator("#livechat-ga4-secret").inputValue(),"");
    assert.equal(await page.getByRole('textbox',{name:'引导问题 1',exact:true}).inputValue(),'如何选择材料？');
    await dialog.getByRole('button',{name:'删除问题 2',exact:true}).click();await dialog.getByRole('button',{name:'删除问题 1',exact:true}).click();
    await save.click();await dialog.waitFor({state:'detached'});assert.deepEqual(writes.at(-1).data.starterMessages,[]);
    await page.getByRole('button',{name:'编辑',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'引导问题 1',exact:true}).count(),0);
    await dialog.getByRole("button",{name:"取消",exact:true}).click();await dialog.waitFor({state:"detached"});
    await page.getByRole("button",{name:"新增渠道",exact:true}).click();await page.keyboard.press("Escape");await dialog.waitFor({state:"detached"});
    assert.deepEqual(errors,[]);await page.close();

    async function assertLayout(state){
      const bounds=await dialog.boundingBox(),button=await save.boundingBox();
      assert.ok(bounds.x>=0&&bounds.x+bounds.width<=viewport.width+1);
      assert.ok(bounds.y>=0&&bounds.y+bounds.height<=viewport.height+1);
      assert.ok(button.y>=0&&button.y+button.height<=viewport.height);
      assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);
      for(const control of await dialog.locator("textarea,select").all()){
        const metrics=await control.evaluate(el=>({width:el.getBoundingClientRect().width,parent:el.parentElement.getBoundingClientRect().width,display:getComputedStyle(el).display,border:getComputedStyle(el).borderTopWidth}));
        assert.ok(Math.abs(metrics.width-metrics.parent)<1);assert.equal(metrics.display,"block");assert.equal(metrics.border,"1px");
      }
      await page.screenshot({path:resolve(output,`${state}-${viewport.width}x${viewport.height}.png`)});
    }
  }
  console.log("4 种视口：新增、编辑回填、必填校验、POST/PUT、错误保留、键盘焦点、取消及布局检查全部通过。");
}finally{await browser?.close();await new Promise(done=>server.close(done));}
