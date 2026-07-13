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
  assert.match(component,/离线队列已启用/);assert.match(component,/可靠同步已启用/);assert.match(component,/aria-live="polite"/);assert.match(css,/@media\(max-width:980px\)/);assert.match(css,/prefers-reduced-motion/);
});
