// 使用真实邮箱配置组件和模拟 API，不访问 Google 或修改业务邮箱。
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import ts from "typescript";
import {chromium} from "playwright";

const require=createRequire(new URL("../services/api/package.json",import.meta.url));
const {build}=require("esbuild");
const source=await readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
const tree=ts.createSourceFile("inbox.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const panel=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="MailboxSettingsPanel");
assert.ok(panel);
const bundle=await build({stdin:{contents:`import React,{useState,useEffect,useCallback} from 'react';
import {createRoot} from 'react-dom/client';
const Plus=()=>null,Trash2=()=>null;
const authorizedFetch=async(path,token,init)=>({token,response:await fetch(path,init)});
${panel.getText(tree)}
const noop=()=>{};
createRoot(document.getElementById('root')).render(<MailboxSettingsPanel token="fixture" onToken={noop} onToast={noop} accounts={[{id:'channel',name:'测试渠道',platform:'livechat'}]}/>);`,resolveDir:process.cwd(),loader:"tsx"},bundle:true,write:false,format:"iife",platform:"browser",define:{"process.env.NODE_ENV":'"production"'}});
const server=createServer((request,response)=>{
  response.setHeader("content-type",request.url==="/bundle.js"?"text/javascript":"text/html; charset=utf-8");
  response.end(request.url==="/bundle.js"?bundle.outputFiles[0].text:'<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>');
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage(),errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  let saved="Label_business",fail=false,writes=0,labelReads=0;
  await page.route("**/api/v1/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path==="/api/v1/mailboxes")return route.fulfill({json:{data:[{id:"gmail",account_id:"channel",address:"test@gmail.com",auth_type:"google",enabled:true,gmail_label_id:saved}]}});
    if(path.endsWith("/google/labels")){
      labelReads++;
      return route.fulfill({status:fail?502:200,json:fail?{message:"无法读取 Gmail 标签，请稍后重试"}:{labels:[{id:"Label_business",name:"belaroprecision.com"},{id:"Label_other",name:"其他业务"}]}});
    }
    assert.equal(request.method(),"PUT");assert.ok(path.endsWith("/google/label"));
    saved=request.postDataJSON().labelId;writes++;
    return route.fulfill({json:{id:"gmail",labelId:saved}});
  });
  const selected=()=>page.getByLabel("test@gmail.com Gmail 收件标签");
  const waitSelected=async name=>{
    await page.waitForFunction(name=>document.querySelector('select')?.selectedOptions[0]?.textContent===name,name);
  };
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await waitSelected("belaroprecision.com");assert.equal(writes,0);assert.ok(labelReads>0);
  await page.reload();await waitSelected("belaroprecision.com");assert.equal(writes,0);
  await selected().selectOption("Label_business");assert.equal(writes,0);
  await selected().selectOption("Label_other");await waitSelected("其他业务");
  assert.equal(writes,1);await page.reload();await waitSelected("其他业务");
  fail=true;await page.reload();await page.getByRole("alert").waitFor();
  assert.equal(await selected().inputValue(),"Label_other");
  assert.ok((await selected().locator("option:checked").textContent()).includes("已保存标签"));
  fail=false;await selected().focus();await waitSelected("其他业务");
  assert.equal(await page.getByRole("alert").count(),0);assert.equal(writes,1);
  assert.deepEqual(errors,[]);
  console.log("通过：自动加载、刷新回显、同标签不重置、切换持久化、读取失败保留 ID 及聚焦重试；无意外写入。");
}finally{await browser?.close();await new Promise(done=>server.close(done));}
