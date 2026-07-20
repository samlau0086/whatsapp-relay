import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/store.js";
import { describeSendError, isTransientSendConnectionError } from "../dist/send-errors.js";

test("temporary WhatsApp disconnects remain queued instead of becoming permanent failures",()=>{
  assert.equal(isTransientSendConnectionError(new Error("1006")),true);
  assert.equal(isTransientSendConnectionError({output:{statusCode:428},message:"Connection Terminated"}),true);
  assert.equal(isTransientSendConnectionError(Object.assign(new Error("socket hang up"),{code:"ECONNRESET"})),true);
  assert.equal(isTransientSendConnectionError(Object.assign(new TypeError("fetch failed"),{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}})),true);
  assert.equal(describeSendError(Object.assign(new TypeError("fetch failed"),{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}})),"fetch failed; UND_ERR_CONNECT_TIMEOUT");
  assert.equal(isTransientSendConnectionError(new Error("not-authorized")),false);
});

test("removed-account status cleanup never skips a message event", () => {
  const directory=mkdtempSync(join(tmpdir(),"relaydesk-store-"));
  const store=new AgentStore(join(directory,"agent.db"));
  try {
    store.upsertAccount("current","Current account","online");
    store.enqueueEvent("status-removed","account_status",{accountId:"removed",status:"offline"});
    store.enqueueEvent("status-current","account_status",{accountId:"current",status:"online"});
    store.enqueueEvent("message-removed","message",{accountId:"removed",messageId:"message-1"});

    assert.equal(store.discardRemovedAccountStatusEvents(),1);
    assert.deepEqual(store.pendingEvents().map(event=>event.event_id),["status-current","message-removed"]);

    store.deleteAccount("current");
    assert.equal(store.discardRemovedAccountStatusEvents(),1);
    assert.deepEqual(store.pendingEvents().map(event=>event.event_id),["message-removed"]);
    assert.equal(store.diagnostics().lastAckedCursor,2);
  } finally {
    store.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test("a definitely unsent command can be deferred and accepted again", () => {
  const directory=mkdtempSync(join(tmpdir(),"relaydesk-store-"));
  const store=new AgentStore(join(directory,"agent.db"));
  try {
    const command={type:"command",sequence:9,commandId:"command-9",accountId:"account-1"};
    assert.equal(store.saveCommand(9,"command-9","account-1",command),true);
    store.deferCommand("command-9");
    assert.equal(store.diagnostics().pendingCommands,0);
    assert.equal(store.saveCommand(9,"command-9","account-1",command),true);
  } finally {
    store.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test("inbound WhatsApp replies are normalized before entering the durable outbox", () => {
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const client=readFileSync(new URL("../dist/central-client.js",import.meta.url),"utf8");
  assert.match(worker,/normalizeMessageContent/);
  assert.match(worker,/jidNormalizedUser/);
  assert.match(worker,/senderName: item\.pushName/);
  assert.match(worker,/getMessage:/);
  assert.match(worker,/saveMessage/);
  assert.match(worker,/listLidMappings/);
  assert.match(worker,/contact_identity/);
  assert.match(worker,/signalRepository\.lidMapping\.getPNForLID/);
  assert.match(worker,/rawChatJid/);
  assert.match(worker,/stickerMessage/);
  assert.match(worker,/sticker-/);
  assert.match(worker,/uploadInboundMedia/);
  assert.match(worker,/attempt < 5/);
  assert.match(worker,/AbortSignal\.timeout\(120_000\)/);
  assert.match(worker,/downloadOutboundMedia/);
  assert.match(worker,/AbortSignal\.timeout\(12_000\)/);
  assert.match(worker,/UndiciProxyAgent/);
  assert.match(worker,/dispatcher: mediaProxyAgent/);
  assert.match(client,/cursor: event\.cursor/);
});

test("stale WhatsApp sockets and stale renderer refreshes cannot overwrite current status", () => {
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const renderer=readFileSync(new URL("../dist/renderer/index.html",import.meta.url),"utf8");
  assert.match(main,/client\s*!==\s*nextClient/);
  assert.match(worker,/connectionGeneration/);
  assert.match(worker,/generation\s*!==\s*connectionGeneration/);
  assert.match(worker,/previousSocket\?\.end/);
  assert.match(renderer,/refreshSequence/);
  assert.match(renderer,/sequence\s*!==\s*refreshSequence/);
});

test("offline accounts can reconnect without clearing their saved session", () => {
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const preload=readFileSync(new URL("../dist/preload.cjs",import.meta.url),"utf8");
  const renderer=readFileSync(new URL("../dist/renderer/index.html",import.meta.url),"utf8");
  assert.match(main,/account:reconnect/);
  assert.match(main,/worker\.send\(\{ type: "reconnect" \}\)/);
  assert.match(worker,/message\.type === "reconnect"/);
  assert.match(worker,/if \(reconnectTimer\)\s*return/);
  assert.match(preload,/reconnectAccount/);
  assert.match(renderer,/data-action="reconnect"/);
  assert.match(renderer,/重新连接/);
});

test("an enrolled agent can change its central URL without replacing credentials", () => {
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  const preload=readFileSync(new URL("../dist/preload.cjs",import.meta.url),"utf8");
  const renderer=readFileSync(new URL("../dist/renderer/index.html",import.meta.url),"utf8");
  assert.match(main,/agent:update-central-url/);
  assert.match(main,/store\.set\("baseUrl", baseUrl\)/);
  assert.match(main,/startCentral\(baseUrl, agentId, credential\)/);
  assert.match(preload,/updateCentralUrl/);
  assert.match(renderer,/central-settings-card/);
  assert.match(renderer,/save-central-url/);
});

test("protocol placeholders can be removed without dropping real replies", () => {
  const directory=mkdtempSync(join(tmpdir(),"relaydesk-store-"));
  const store=new AgentStore(join(directory,"agent.db"));
  try {
    store.enqueueEvent("empty","message",{accountId:"a",kind:"text"});
    store.enqueueEvent("reply","message",{accountId:"a",kind:"text",text:"hello"});
    assert.equal(store.discardUnsupportedMessageEvents(),1);
    assert.deepEqual(store.pendingEvents().map(event=>event.event_id),["reply"]);
  } finally {
    store.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
