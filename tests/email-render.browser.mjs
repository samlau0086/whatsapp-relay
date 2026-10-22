// Run after the API build. Uses a local Playwright installation (or PLAYWRIGHT_MODULE).
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {createServer} from "node:http";
import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";
import {sanitizeEmailDisplayHtml} from "../services/api/dist/email-display.js";

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||"playwright");
const {build}=createRequire(new URL("../services/api/package.json",import.meta.url))("esbuild");
const logo='<svg xmlns="http://www.w3.org/2000/svg" width="250" height="46"><g fill="#f90"><circle cx="25" cy="25" r="18"/><circle cx="47" cy="18" r="15"/><path d="M5 25h62v17H5z"/></g><text x="78" y="33" font-family="Arial" font-weight="bold" font-size="21">CLOUDFLARE</text></svg>';
let mediaRequests=0;
const server=createServer((request,response)=>{
  if(request.url==="/bundle.js"){response.setHeader("Content-Type","text/javascript");response.end(bundle.outputFiles[0].text);}
  else if(request.url==="/logo.svg"){response.setHeader("Content-Type","image/svg+xml");setTimeout(()=>response.end(logo),150);}
  else if(request.url==="/api/v1/media/image-1"){
    assert.equal(request.headers.authorization,"Bearer browser-test");mediaRequests++;
    response.setHeader("Content-Type","image/png");response.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNxkAAAAASUVORK5CYII=","base64"));
  }else{
    response.setHeader("Content-Type","text/html");
    response.end('<!doctype html><style>body{margin:0;background:#eef3ef;font:14px Arial;padding:16px}p{color:red!important;font-size:50px!important}table{display:none!important}.message-bubble{padding:12px;background:#fff;border-radius:8px;width:760px;max-width:96%;box-sizing:border-box}.email-html-frame{display:block;width:100%;border:0;min-height:120px}</style><div id="root"></div><script src="/bundle.js"></script>');
  }
});
await new Promise(done=>server.listen(0,"127.0.0.1",done));
const origin=`http://127.0.0.1:${server.address().port}`;
const html=sanitizeEmailDisplayHtml(`<html><head><style>.cta{display:inline-block;border-radius:24px;background:#ff6633;color:#fff;padding:12px 24px;text-decoration:none}@media(max-width:600px){.card{width:100%!important}.content{padding:20px!important}}</style></head><body style="background:#f5f5f5;padding:24px 8px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table class="card" width="600" style="background:#fff;border-top:8px solid #f90" cellpadding="0" cellspacing="0"><tr><td class="content" style="padding:32px"><img src="${origin}/logo.svg" width="250" height="46" alt="Cloudflare"><p style="margin-top:48px">Hello,</p><p><strong>To ensure the security of your account, please immediately deploy the latest stable release of Cloudflare One Client on all platforms.</strong> This is a critical update.</p><p>We have not observed any exploitation against Cloudflare related to this incident.</p><p style="margin:32px 0"><a class="cta" href="https://example.com/download">Download Cloudflare One Client</a></p><p>Thank you,<br>The Cloudflare Team</p><img src="cid:logo@example.com" alt="Inline attachment" width="24" height="24"></td></tr></table><p style="color:#999;font-size:12px">Copyright © 2026 Cloudflare, Inc.</p></td></tr></table><script>parent.__mailAttack=true</script><img src="javascript:alert(1)" onerror="parent.__mailAttack=true"></body></html>`);
const fixture=`import React from "react";import{createRoot}from"react-dom/client";import{EmailHtmlBody}from"./app/email-html-body";const attachments=[{id:"image-1",contentId:"logo@example.com",inline:true,mime:"image/png"}];createRoot(document.getElementById("root")).render(React.createElement("div",{className:"message-bubble"},React.createElement(EmailHtmlBody,{html:${JSON.stringify(html)},attachments,token:"browser-test",onToken:()=>{},onReady:()=>{}})));`;
const bundle=await build({stdin:{contents:fixture,resolveDir:resolve("."),loader:"tsx"},bundle:true,write:false,format:"iife",jsx:"automatic",define:{"process.env.NODE_ENV":'"production"',"process.env.NEXT_PUBLIC_RELAY_API_URL":'""'}});
let browser;
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1100,height:1000}});
  const errors=[];page.on("pageerror",error=>errors.push(error.message));
  await page.goto(origin);
  const frame=page.frameLocator("iframe");
  await frame.locator(".cta").waitFor();
  await page.waitForFunction(()=>{const frame=document.querySelector("iframe");const images=frame?.contentDocument?.images;return images?.length&&Array.from(images).filter(image=>image.alt==="Cloudflare"||image.alt==="Inline attachment").every(image=>image.complete&&image.naturalWidth>0);});
  assert.equal(await frame.locator(".cta").evaluate(node=>getComputedStyle(node).backgroundColor),"rgb(255, 102, 51)");
  assert.equal(await frame.locator(".card").evaluate(node=>getComputedStyle(node).display),"table");
  assert.notEqual(await frame.locator("p").first().evaluate(node=>getComputedStyle(node).color),"rgb(255, 0, 0)");
  assert.equal(await page.evaluate(()=>window.__mailAttack),undefined);
  assert.equal(await frame.locator("a").getAttribute("target"),"_blank");
  const dimensions=await page.locator("iframe").evaluate(node=>({height:node.clientHeight,content:node.contentDocument.body.scrollHeight}));
  assert.ok(dimensions.height>=dimensions.content,JSON.stringify(dimensions));
  assert.equal(mediaRequests,1);
  await mkdir("outputs",{recursive:true});
  await page.screenshot({path:"outputs/email-render-desktop.png",fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>document.querySelector("iframe").clientWidth<390);
  assert.ok(await frame.locator(".card").evaluate(node=>node.getBoundingClientRect().width)<390);
  await page.screenshot({path:"outputs/email-render-mobile.png",fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:"passed",mediaRequests,dimensions,screenshots:["outputs/email-render-desktop.png","outputs/email-render-mobile.png"]}));
}finally{await browser?.close();await new Promise(done=>server.close(done));}
