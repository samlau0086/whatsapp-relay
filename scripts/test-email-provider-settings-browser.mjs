// 真实组件与全局样式，模拟 API，不修改业务渠道或发送真实邮件。
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
const {build}=require("esbuild"),root=fileURLToPath(new URL("..",import.meta.url));
const accounts=[{id:"channel-a",name:"网站客服",platform:"livechat"},{id:"channel-b",name:"海外销售 WhatsApp",platform:"whatsapp"}];
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {EmailProviderSettings} from './app/email-provider-settings';const noop=()=>{};createRoot(document.getElementById('root')).render(<EmailProviderSettings token="fixture" accounts={${JSON.stringify(accounts)}} onToken={noop} onToast={noop}/>);`;
const bundle=await build({stdin:{contents:entry,resolveDir:root,loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_RELAY_API_URL":'""'}});
const css=(await postcss([tailwindcss()]).process(await readFile(resolve(root,"app/globals.css"),"utf8"),{from:resolve(root,"app/globals.css")})).css;
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("content-type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else{response.setHeader("content-type","text/html");response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}html,body{height:auto;overflow:visible}body{padding:16px}</style><div id="root"></div><script src="/bundle.js"></script></html>`);}
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));let browser;
try{
  browser=await chromium.launch({headless:true});
  const output=resolve(root,"outputs/email-provider-settings");await mkdir(output,{recursive:true});
  for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:320,height:568}]){
    const page=await browser.newPage({viewport}),errors=[],writes=[];let failSave=false;
    const make=(id,name,provider)=>({id,name,provider,enabled:true,isDefault:id==="smtp-a",configured:true,fromName:"客服团队",fromEmail:`${id}@example.com`,replyTo:"",host:"smtp.example.com",port:587,tls:"starttls",username:"support"});
    let providers=[make("smtp-a","SMTP 主账号","smtp"),make("smtp-b","SMTP 备用账号","smtp"),make("resend-a","Resend 国内团队","resend"),make("resend-b","Resend 海外团队","resend")],bindings={};
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/api/v1/admin/email-provider**",async route=>{
      const request=route.request(),url=new URL(request.url());
      if(request.method()==="GET")return route.fulfill({json:{data:providers,bindings:Object.entries(bindings).map(([account_id,provider_id])=>({account_id,provider_id}))}});
      const data=request.postDataJSON();writes.push({url:url.pathname,data});
      if(failSave)return route.fulfill({status:409,json:{error:"测试保存失败"}});
      if(url.pathname.includes("email-provider-bindings")){
        const account=url.pathname.split("/").at(-1);if(data.providerId)bindings[account]=data.providerId;else delete bindings[account];
      }else if(!url.pathname.endsWith("/test")){
        const id=url.pathname.split("/").at(-1),item={...data,id,configured:true,secret:undefined};
        providers=[...providers.filter(p=>p.id!==id),item];
      }
      await route.fulfill({json:{saved:true}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole("button",{name:"SMTP 主账号",exact:false}).waitFor();
    assert.equal(await page.locator(".provider-list button").count(),4);
    await layout("initial");
    await page.getByRole("button",{name:"新增 Resend",exact:true}).click();
    await page.getByLabel("配置名称",{exact:true}).fill("Resend 新品牌");
    await page.getByLabel("发件人名称",{exact:true}).fill("新品牌团队");
    await page.getByLabel("发件人邮箱",{exact:true}).fill("brand@example.com");
    await page.getByLabel("Resend API Key",{exact:true}).fill("test-secret");
    await page.getByRole("button",{name:"保存配置",exact:true}).click();
    await page.getByLabel("Resend API Key",{exact:true}).waitFor();
    await page.waitForFunction(()=>document.querySelectorAll('.provider-list button').length===5&&!document.querySelector('[aria-busy="true"]'));
    assert.equal(writes[0].data.provider,"resend");assert.equal(writes[0].data.secret,"test-secret");
    await page.getByLabel("配置名称",{exact:true}).fill("Resend 新品牌改名");
    await page.getByRole("button",{name:"保存配置",exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    assert.equal(writes[1].data.secret,undefined);
    await page.getByLabel("测试收件邮箱",{exact:true}).fill("test@example.com");
    await page.getByRole("button",{name:"发送测试邮件",exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    assert.equal(writes[2].data.recipientEmail,"test@example.com");
    const rows=page.locator(".email-channel-binding");
    for(const [index,id] of ["smtp-b","resend-b"].entries()){
      await rows.nth(index).locator("select").selectOption(id);await rows.nth(index).getByRole("button",{name:"保存",exact:true}).click();
      await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    }
    assert.deepEqual(bindings,{"channel-a":"smtp-b","channel-b":"resend-b"});
    await rows.nth(0).locator("select").selectOption("");await rows.nth(0).getByRole("button",{name:"保存",exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('[aria-busy="true"]'));
    assert.equal(bindings["channel-a"],undefined);assert.equal(bindings["channel-b"],"resend-b");
    failSave=true;await page.getByLabel("配置名称",{exact:true}).fill("保留未保存名称");
    await page.getByRole("button",{name:"保存配置",exact:true}).click();await page.getByRole("alert").waitFor();
    assert.equal(await page.getByLabel("配置名称",{exact:true}).inputValue(),"保留未保存名称");
    await layout("edited");assert.deepEqual(errors,[]);await page.close();
    async function layout(state){
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      for(const control of await page.locator("input,select,button").all()){
        const box=await control.boundingBox();if(box)assert.ok(box.x>=0&&box.x+box.width<=viewport.width+1,`控件越界 ${await control.getAttribute("aria-label")}`);
      }
      await page.screenshot({path:resolve(output,`${state}-${viewport.width}x${viewport.height}.png`),fullPage:true});
    }
  }
  console.log("3 种视口：同类型多实例、新增保存、密钥留空、测试邮件、独立绑定与取消绑定、失败保留及布局检查通过。");
}finally{await browser?.close();await new Promise(done=>server.close(done));}
