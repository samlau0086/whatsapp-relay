import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/store.js";
import { centralMediaAuthorizationError, describeSendError, isCentralMediaAuthorizationError, isSendConfirmationTimeout, isTransientSendConnectionError, waitForSendConfirmation } from "../dist/send-errors.js";

test("temporary WhatsApp disconnects remain queued instead of becoming permanent failures",()=>{
  assert.equal(isTransientSendConnectionError(new Error("1006")),true);
  assert.equal(isTransientSendConnectionError({output:{statusCode:428},message:"Connection Terminated"}),true);
  assert.equal(isTransientSendConnectionError(Object.assign(new Error("socket hang up"),{code:"ECONNRESET"})),true);
  assert.equal(isTransientSendConnectionError(Object.assign(new TypeError("fetch failed"),{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}})),true);
  assert.equal(isTransientSendConnectionError(new DOMException("The operation was aborted due to timeout","TimeoutError")),true);
  assert.equal(describeSendError(Object.assign(new TypeError("fetch failed"),{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}})),"fetch failed; UND_ERR_CONNECT_TIMEOUT");
  assert.equal(isTransientSendConnectionError(new Error("not-authorized")),false);
});

test("temporary central media authorization failures remain queued",()=>{
  const error=centralMediaAuthorizationError(403);
  assert.equal(isCentralMediaAuthorizationError(error),true);
  assert.equal(isCentralMediaAuthorizationError(new Error("Media download failed: HTTP 403")),false);
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  assert.match(worker,/central_media_authorization_pending/);
  assert.match(worker,/outcome:\s*"deferred"/);
});

test("a hung WhatsApp send becomes uncertain before the parent executor timeout",async()=>{
  const never=new Promise(()=>{});
  await assert.rejects(waitForSendConfirmation(never,5),error=>isSendConfirmationTimeout(error));
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  assert.match(worker,/waitForSendConfirmation\(socket\.sendMessage/);
  assert.match(worker,/send_confirmation_timeout_reconnecting/);
  assert.match(worker,/outcome:\s*"uncertain"/);
  assert.match(worker,/void connect\(options\)/);
  assert.match(worker,/command_accepted/);
  assert.match(worker,/command_started/);
  assert.match(worker,/worker_heartbeat/);
  assert.match(main,/account_worker_unresponsive/);
  assert.match(main,/account_worker_stalled/);
  assert.match(main,/restartUnresponsiveWorker/);
  assert.match(main,/lastWorkerHeartbeat/);
  assert.doesNotMatch(main,/Command timed out after 90 seconds/);
});

test("transient WhatsApp send failures mark the account offline and rebuild the socket",()=>{
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  assert.match(worker,/send_deferred_after_transient_error/);
  assert.match(worker,/status:\s*"offline"/);
  assert.match(worker,/command remains queued while the connection is rebuilt/);
  assert.match(worker,/void connect\(options\)/);
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
  assert.match(worker,/documentMessage\?\.caption/);
  assert.match(worker,/jidNormalizedUser/);
  assert.match(worker,/rawJid\.endsWith\("@broadcast"\)/);
  assert.match(worker,/const remotePushName\s*=\s*item\.key\.fromMe\s*\?\s*undefined\s*:\s*item\.pushName\s*\?\?\s*undefined/);
  assert.match(worker,/senderName:\s*remotePushName/);
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
  assert.match(worker,/AbortSignal\.timeout\(60_000\)/);
  assert.match(worker,/fetch\(new URL\(`\/agent\/media\/\$\{encodeURIComponent\(mediaId\)\}`/);
  assert.doesNotMatch(worker,/downloadOutboundMedia[\s\S]*?dispatcher: mediaProxyAgent[\s\S]*?function messageTime/);
  assert.match(worker,/UndiciProxyAgent/);
  assert.match(worker,/dispatcher: mediaProxyAgent/);
  assert.match(client,/cursor: event\.cursor/);
});

test("outbound messages inherit each chat's disappearing-message duration",()=>{
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  assert.match(worker,/messaging-history\.set".*chats.*lidPnMappings.*rememberChatEphemeralExpirations/s);
  assert.match(worker,/chats\.upsert.*rememberChatEphemeralExpirations/s);
  assert.match(worker,/chats\.update.*rememberChatEphemeralExpirations/s);
  assert.match(worker,/chat\.ephemeralExpiration === undefined/);
  assert.match(worker,/rememberChatJidAlias/);
  assert.match(worker,/ephemeralSetting\s*=\s*chatEphemeralSettings\.get\(jidNormalizedUser\(toJid\)\)/);
  assert.match(worker,/ephemeralSettingTimestamp:\s*ephemeralSetting\.settingTimestamp/);
  assert.match(worker,/disappearingMode:\s*ephemeralSetting\.disappearingMode/);
  assert.match(worker,/socket\.sendMessage\(toJid,\s*content,\s*sendOptions\)/);
});

test("status publishing uses the stories JID, a recipient snapshot, and broadcast mode",()=>{
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const client=readFileSync(new URL("../dist/central-client.js",import.meta.url),"utf8");
  assert.match(worker,/command\.command\s*===\s*"publish_status"/);
  assert.match(worker,/sendMessage\("status@broadcast",\s*content,\s*\{\s*broadcast:\s*true,\s*statusJidList/);
  assert.match(client,/capabilities:\s*this\.options\.capabilities/);
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

test("only one desktop agent instance can own the shared WhatsApp sessions", () => {
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  assert.match(main,/requestSingleInstanceLock/);
  assert.match(main,/if\s*\(!hasSingleInstanceLock\)\s*\{\s*app\.quit\(\)/);
  assert.match(main,/app\.on\("second-instance",\s*showWindow\)/);
});

test("offline accounts can reconnect without clearing their saved session", () => {
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const preload=readFileSync(new URL("../dist/preload.cjs",import.meta.url),"utf8");
  const renderer=readFileSync(new URL("../dist/renderer/index.html",import.meta.url),"utf8");
  assert.match(main,/account:reconnect/);
  assert.match(main,/intentionalRestarts\.add\(input\.id\)/);
  assert.match(main,/worker\.kill\(\)/);
  assert.match(worker,/message\.type === "reconnect"/);
  assert.match(worker,/if \(reconnectTimer\)\s*return/);
  assert.match(worker,/connectTimeoutMs: 60_000/);
  assert.match(preload,/reconnectAccount/);
  assert.match(renderer,/data-action="reconnect"/);
  assert.match(renderer,/重新连接/);
});

test("account worker output pipes stay drained so warnings cannot block heartbeats", () => {
  const main = readFileSync(new URL("../dist/main.js", import.meta.url), "utf8");
  assert.match(main, /worker\.stdout\?\.resume\(\)/);
  assert.match(main, /worker\.stderr\?\.resume\(\)/);
});

test("WhatsApp version discovery uses the configured proxy", () => {
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  assert.match(worker,/fetchLatestBaileysVersion\(\s*mediaProxyAgent\s*\?\s*\{\s*dispatcher:\s*mediaProxyAgent\s*\}/);
});

test("the central WebSocket uses the configured proxy and reconnects after proxy changes", () => {
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  const client=readFileSync(new URL("../dist/central-client.js",import.meta.url),"utf8");
  assert.match(client,/HttpsProxyAgent/);
  assert.match(client,/new HttpsProxyAgent\(this\.options\.proxyUrl\)/);
  assert.match(client,/constructor\(store,\s*options\)/);
  assert.match(client,/this\.options\.proxyUrl/);
  assert.match(main,/function restartCentral\(\)/);
  assert.match(main,/void connectCentral\(\{ agentId, credential, baseUrl \}\)/);
  assert.match(main,/resolveProxyUrl\(input\.baseUrl\)/);
});

test("an enrolled agent can change its central URL without replacing credentials", () => {
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  const preload=readFileSync(new URL("../dist/preload.cjs",import.meta.url),"utf8");
  const renderer=readFileSync(new URL("../dist/renderer/index.html",import.meta.url),"utf8");
  assert.match(main,/agent:update-central-url/);
  assert.match(main,/store\.set\("baseUrl", baseUrl\)/);
  assert.match(main,/restartCentral\(\)/);
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

test("known contact identities can be replayed once to restore synchronized names", () => {
  const directory=mkdtempSync(join(tmpdir(),"relaydesk-store-"));
  const store=new AgentStore(join(directory,"agent.db"));
  try {
    store.enqueueEvent("identity-original","contact_identity",{accountId:"account-1",lidJid:"36628034810005@lid",phoneJid:"966547413706@s.whatsapp.net",displayName:"bora"});
    store.enqueueEvent("identity-empty","contact_identity",{accountId:"account-2",lidJid:"36628034810006@lid",phoneJid:"966547413707@s.whatsapp.net"});
    assert.equal(store.requeueKnownContactIdentities(),1);
    const replay=store.pendingEvents().find(event=>event.event_id.startsWith("identity-name-recovery-v1:"));
    assert.ok(replay);
    assert.equal(JSON.parse(replay.payload).displayName,"bora");
    assert.equal(store.requeueKnownContactIdentities(),0);
  } finally {
    store.close();
    rmSync(directory,{recursive:true,force:true});
  }
});

test("group chat capability synchronizes metadata and preserves quoted participants",()=>{
  const packageMetadata=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  const main=readFileSync(new URL("../dist/main.js",import.meta.url),"utf8");
  const docker=readFileSync(new URL("../dist/docker-main.js",import.meta.url),"utf8");
  const worker=readFileSync(new URL("../dist/account-worker.js",import.meta.url),"utf8");
  const central=readFileSync(new URL("../dist/central-client.js",import.meta.url),"utf8");
  assert.match(packageMetadata.version,/^\d+\.\d+\.\d+$/);
  assert.match(main,/group_chat_v1/);
  assert.match(docker,/group_chat_v1/);
  assert.match(worker,/groupFetchAllParticipating/);
  assert.match(worker,/group_sync_complete/);
  assert.match(worker,/group-participants\.update/);
  assert.match(worker,/chatType:\s*isGroup\s*\?\s*"group"/);
  assert.match(worker,/participant:\s*quotedParticipantJid\s*\|\|\s*undefined/);
  assert.match(central,/bytes\s*>\s*1_750_000/);
});
