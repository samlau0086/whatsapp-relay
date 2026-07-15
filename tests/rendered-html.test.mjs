import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS:{ fetch:async()=>new Response("Not found",{status:404}) } }, { waitUntil(){},passThroughOnException(){} });
}

test("server-renders the RelayDesk inbox", async () => {
  const response=await render();assert.equal(response.status,200);const html=await response.text();
  assert.match(html,/RelayDesk/);assert.match(html,/WhatsApp/);assert.match(html,/消息聚合平台/);assert.doesNotMatch(html,/codex-preview|Your site is taking shape/);
});

test("workspace includes the reliable-sync UI and responsive breakpoints", async()=>{
  const [component,css]=await Promise.all([readFile(new URL("../app/whatsapp-inbox.tsx",import.meta.url),"utf8"),readFile(new URL("../app/globals.css",import.meta.url),"utf8")]);
  assert.match(component,/离线队列已启用/);assert.match(component,/中心真实数据/);assert.match(component,/Agent 管理/);assert.match(component,/移除 Agent/);assert.match(component,/新建 WhatsApp 会话/);assert.match(component,/创建会话并发送/);assert.match(component,/tokenRole/);assert.match(component,/45_000/);assert.match(component,/aria-live="polite"/);assert.match(component,/生成一次性注册码/);assert.match(component,/\/api\/v1\/agents\/enrollment/);assert.match(component,/\/api\/v1\/agents/);assert.match(component,/\/api\/v1\/conversations/);assert.match(component,/\/api\/v1\/media/);assert.doesNotMatch(component,/aria-label="添加附件" disabled|Pharah House|Penny Valeria|Richard Hammon/);assert.match(css,/\.relay-shell \{ width:100vw; height:100vh; height:100dvh/);assert.match(css,/border-radius:0; box-shadow:none/);assert.match(css,/\.new-conversation-dialog/);assert.match(css,/\.management-panel/);assert.match(css,/@media\(max-width:980px\)/);assert.match(css,/prefers-reduced-motion/);
});
