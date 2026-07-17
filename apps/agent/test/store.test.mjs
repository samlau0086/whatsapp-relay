import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/store.js";

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
  assert.match(worker,/UndiciProxyAgent/);
  assert.match(worker,/dispatcher: mediaProxyAgent/);
  assert.match(client,/cursor: event\.cursor/);
});

test("stale WhatsApp sockets and stale renderer refreshes cannot overwrite current status", () => {
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const renderer=readFileSync(new URL("../dist/renderer/index.html",import.meta.url),"utf8");
  assert.match(worker,/connectionGeneration/);
  assert.match(worker,/generation\s*!==\s*connectionGeneration/);
  assert.match(worker,/previousSocket\?\.end/);
  assert.match(renderer,/refreshSequence/);
  assert.match(renderer,/sequence\s*!==\s*refreshSequence/);
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
