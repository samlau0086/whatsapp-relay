import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, safeStorage, session, Tray } from "electron";
import QRCode from "qrcode";
import { AgentStore } from "./store.js";
import { CentralClient } from "./central-client.js";

const PROTOCOL_VERSION = 2;
const DEFAULT_CENTRAL_URL = "https://wsdesk.geekmt.com";
const STABLE_USER_DATA = join(app.getPath("appData"), "@relaydesk", "windows-agent");
const APP_ICON_PATH = join(import.meta.dirname, "assets", "icon.ico");
const ATTENTION_ICON_PATH = join(import.meta.dirname, "assets", "icon-attention.ico");
if(process.platform==="win32")app.setAppUserModelId("com.relaydesk.agent");
mkdirSync(STABLE_USER_DATA,{recursive:true});
app.setPath("userData", STABLE_USER_DATA);
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let trayIcon: Electron.NativeImage | undefined;
let trayAttentionIcon: Electron.NativeImage | undefined;
let trayFlashTimer: NodeJS.Timeout | undefined;
const attentionKeys=new Set<string>();
const messageNotifications=new Map<string,Notification>();
let store: AgentStore;
let client: CentralClient | undefined;
let masterKey = "";
let quitting = false;
const workers = new Map<string, ChildProcess>();
const intentionalRestarts = new Set<string>();
const removedWorkers = new Set<string>();
const repairWorkers = new Set<string>();
const unresponsiveWorkers = new Set<string>();
const qrCodes = new Map<string,{dataUrl:string;generatedAt:number}>();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
    const dataDir = app.getPath("userData");
    store = new AgentStore(join(dataDir, "relay-agent.db"));
    store.discardRemovedAccountStatusEvents();
    store.discardUnsupportedMessageEvents();
    masterKey = await loadMasterKey(dataDir);
    createWindow();
    createTray();
    const agentId = store.get("agentId");
    const credential = store.get("credential");
    const baseUrl = store.get("baseUrl");
    if (agentId && credential && baseUrl) startCentral(baseUrl, agentId, credential);
    for (const account of store.accounts()) await startAccount(account.id, account.name, dataDir);
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 620,
    minHeight: 520,
    title: `RelayDesk Agent v${app.getVersion()}`,
    backgroundColor: "#f4f7f5",
    icon: APP_ICON_PATH,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(join(import.meta.dirname, "renderer", "index.html"));
  window.on("focus", stopAttention);
  window.on("show", stopAttention);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
}

function createTray(): void {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  if (icon.isEmpty()) throw new Error(`Tray icon could not be loaded: ${APP_ICON_PATH}`);
  const attentionIcon = nativeImage.createFromPath(ATTENTION_ICON_PATH);
  if (attentionIcon.isEmpty()) throw new Error(`Tray attention icon could not be loaded: ${ATTENTION_ICON_PATH}`);
  trayIcon=icon;
  trayAttentionIcon=attentionIcon;
  tray = new Tray(icon);
  tray.setToolTip(`RelayDesk WhatsApp Agent v${app.getVersion()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 RelayDesk Agent", click: showWindow },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("double-click", showWindow);
}

function showWindow():void{
  stopAttention();
  window?.show();
  window?.focus();
}

function startAttention(key:string):void{
  if(!window||window.isFocused())return;
  attentionKeys.add(key);
  window.flashFrame(true);
  if(trayFlashTimer||!tray||!trayIcon||!trayAttentionIcon)return;
  let attentionVisible=false;
  trayFlashTimer=setInterval(()=>{
    attentionVisible=!attentionVisible;
    tray?.setImage(attentionVisible?trayAttentionIcon!:trayIcon!);
  },500);
}

function stopAttention():void{
  attentionKeys.clear();
  for(const notification of messageNotifications.values())notification.close();
  messageNotifications.clear();
  stopVisualAttention();
}

function clearAttention(accountId:string,chatJid:string):void{
  const key=attentionKey(accountId,chatJid);
  attentionKeys.delete(key);
  messageNotifications.get(key)?.close();
  messageNotifications.delete(key);
  if(!attentionKeys.size)stopVisualAttention();
}

function stopVisualAttention():void{
  window?.flashFrame(false);
  if(trayFlashTimer){clearInterval(trayFlashTimer);trayFlashTimer=undefined;}
  if(tray&&trayIcon)tray.setImage(trayIcon);
}

ipcMain.handle("agent:state", async () => ({
  baseUrl: store.get("baseUrl") ?? DEFAULT_CENTRAL_URL,
  enrolled: Boolean(store.get("credential")),
  connection: store.get("connection") ?? "offline",
  version: app.getVersion(),
  protocolVersion: PROTOCOL_VERSION,
  accounts: store.accounts(),
  proxy: await proxyState(),
  latestQr: latestQr(),
}));

ipcMain.handle("agent:diagnostics", async () => ({
  generatedAt: new Date().toISOString(),
  appVersion: app.getVersion(),
  protocolVersion: PROTOCOL_VERSION,
  platform: `${process.platform}-${process.arch}`,
  centralConnection: store.get("connection") ?? "offline",
  baseUrl: store.get("baseUrl") ?? "",
  userDataPath: app.getPath("userData"),
  enrolled: Boolean(store.get("credential")),
  accounts: store.accounts().map(({ id, name, status, last_error }) => ({ id, name, status, lastError: last_error })),
  proxy: await proxyState(),
  queue: store.diagnostics(),
  lastSyncError: store.get("lastSyncError")||null,
}));

ipcMain.handle("proxy:save", async (_event, input: {mode:string;url?:string}) => {
  const mode = input.mode;
  if (!['auto', 'direct', 'manual'].includes(mode)) throw new Error("代理模式无效");
  const url = mode === "manual" ? normalizeManualProxy(input.url ?? "") : "";
  store.set("proxyMode", mode);
  store.set("proxyUrl", url);
  for (const [accountId, worker] of workers) {
    intentionalRestarts.add(accountId);
    worker.kill();
  }
  return { ok: true, proxy: await proxyState() };
});

ipcMain.handle("agent:enroll", async (_event, input: {baseUrl:string;code:string;name:string}) => {
  const response = await fetch(new URL("/api/v1/agents/enroll", input.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: input.code, name: input.name, version: app.getVersion(), platform: `win32-${process.arch}` }),
  });
  if (!response.ok) throw new Error("注册码无效或已过期");
  const data = await response.json() as {agentId:string;credential:string};
  store.set("baseUrl", input.baseUrl);
  store.set("agentId", data.agentId);
  store.set("credential", data.credential);
  startCentral(input.baseUrl, data.agentId, data.credential);
  return { ok: true };
});

ipcMain.handle("agent:update-central-url", async (_event, input: {baseUrl:string}) => {
  const agentId = store.get("agentId");
  const credential = store.get("credential");
  if (!agentId || !credential) throw new Error("设备尚未注册到中心平台");
  const baseUrl = normalizeCentralUrl(input.baseUrl);
  store.set("baseUrl", baseUrl);
  store.set("connection", "offline");
  startCentral(baseUrl, agentId, credential);
  return { ok:true, baseUrl };
});

ipcMain.handle("account:add", async (_event, input: {id:string;name:string}) => {
  const baseUrl = store.get("baseUrl") ?? DEFAULT_CENTRAL_URL;
  const credential = store.get("credential");
  if (!credential) throw new Error("设备尚未注册到中心平台");
  const response = await fetchWithRetry(new URL("/agent/accounts", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as {error?:string;message?:string};
    throw new Error(body.error === "account_conflict" ? "账号 ID 已被其他 Agent 使用" : `中心账号登记失败（HTTP ${response.status}${body.error?` · ${body.error}`:""}）`);
  }
  store.upsertAccount(input.id, input.name, "pairing");
  await startAccount(input.id, input.name, app.getPath("userData"));
  return { ok: true };
});

ipcMain.handle("account:update", async (_event, input: {id:string;name:string}) => {
  const name=input.name.trim();if(name.length<2||name.length>80)throw new Error("账号名称需要 2–80 个字符");
  await accountRequest(input.id,"PATCH",{name});
  store.renameAccount(input.id,name);
  return {ok:true};
});

ipcMain.handle("account:reconnect", async (_event, input: {id:string}) => {
  const account=store.accounts().find(item=>item.id===input.id);if(!account)throw new Error("账号不存在");
  store.setAccountStatus(input.id,"offline","正在重新连接");
  const worker=workers.get(input.id);
  // Restarting the worker makes auto mode resolve the current Windows proxy
  // again. A long-running worker may otherwise keep retrying a proxy endpoint
  // that was selected when the app started but has since changed or recovered.
  if(worker){intentionalRestarts.add(input.id);worker.kill();}
  else await startAccount(input.id,account.name,app.getPath("userData"));
  return {ok:true};
});

ipcMain.handle("account:repair", async (_event, input: {id:string}) => {
  const account=store.accounts().find(item=>item.id===input.id);if(!account)throw new Error("账号不存在");
  await accountRequest(input.id,"PATCH",{status:"pairing"});
  store.setAccountStatus(input.id,"pairing");
  qrCodes.delete(input.id);
  const worker=workers.get(input.id);
  if(worker){repairWorkers.add(input.id);worker.send({type:"shutdown",logout:true});setTimeout(()=>{if(workers.get(input.id)===worker)worker.kill();},3000);}
  else await resetAccountAuthAndStart(input.id,account.name,app.getPath("userData"));
  return {ok:true};
});

ipcMain.handle("account:remove", async (_event, input: {id:string}) => {
  const account=store.accounts().find(item=>item.id===input.id);if(!account)throw new Error("账号不存在");
  await accountRequest(input.id,"DELETE");
  const worker=workers.get(input.id);
  if(worker){removedWorkers.add(input.id);worker.send({type:"shutdown",logout:true});setTimeout(()=>{if(workers.get(input.id)===worker)worker.kill();},3000);}
  store.deleteAccount(input.id);
  store.discardRemovedAccountStatusEvents();
  qrCodes.delete(input.id);
  window?.webContents.send("agent:event",{type:"qr_cleared",accountId:input.id});
  await rm(join(app.getPath("userData"),"accounts",input.id),{recursive:true,force:true});
  return {ok:true};
});

function startCentral(baseUrl: string, agentId: string, credential: string): void {
  client?.stop();
  const nextClient = new CentralClient(
    store,
    baseUrl,
    agentId,
    credential,
    app.getVersion(),
    `win32-${process.arch}`,
    PROTOCOL_VERSION,
    ["publish_status_v1"],
    executeWorkerCommand,
    (status) => {
      if (client !== nextClient) return;
      store.set("connection", status);
      window?.webContents.send("agent:event", { type: "central_status", status });
    },
    ({accountId,chatJid})=>clearAttention(accountId,chatJid),
  );
  client = nextClient;
  nextClient.start();
}

async function executeWorkerCommand(command:{sequence:number;commandId:string;accountId:string;command:string;payload:Record<string,unknown>}):Promise<Record<string,unknown>> {
  const worker = workers.get(command.accountId);
  if (!worker) return deferredCommand(command, "account_worker_unavailable", "Account worker is restarting; command remains queued");
  return await new Promise((resolve) => {
    let settled=false;
    let started=false;
    let executionTimer:NodeJS.Timeout|undefined;
    const acceptanceTimer=setTimeout(()=>{
      finish(deferredCommand(command,"account_worker_unresponsive","Account worker did not accept the command; it is being restarted"));
      restartUnresponsiveWorker(command.accountId,worker,"命令执行器无响应，正在自动重新连接");
    },5_000);
    const cleanup=()=>{
      clearTimeout(acceptanceTimer);
      if(executionTimer)clearTimeout(executionTimer);
      worker.off("message",onMessage);
      worker.off("exit",onExit);
    };
    const finish=(result:Record<string,unknown>)=>{
      if(settled)return;
      settled=true;
      cleanup();
      resolve(result);
    };
    const onMessage=(message:Record<string,unknown>)=>{
      if(message.commandId!==command.commandId)return;
      if(message.type==="command_accepted")clearTimeout(acceptanceTimer);
      if(message.type==="command_started"&&!started){
        started=true;
        clearTimeout(acceptanceTimer);
        executionTimer=setTimeout(()=>{
          finish(uncertainCommand(command,"account_worker_stalled","Account worker stopped responding during send; the connection is being rebuilt"));
          restartUnresponsiveWorker(command.accountId,worker,"发送执行超时，正在自动重新连接");
        },70_000);
      }
      if(message.type==="command_result")finish(message);
    };
    const onExit=()=>finish(started
      ? uncertainCommand(command,"account_worker_restarted","Account worker restarted while sending; delivery could not be confirmed")
      : deferredCommand(command,"account_worker_restarted","Account worker restarted before sending; command remains queued"));
    worker.on("message",onMessage);
    worker.once("exit",onExit);
    worker.send({type:"command",...command},error=>{
      if(error)finish(deferredCommand(command,"account_worker_ipc_failed",`Could not dispatch command to account worker: ${error.message}`));
    });
  });
}

function deferredCommand(command:{sequence:number;commandId:string},errorCode:string,errorMessage:string):Record<string,unknown>{
  return {type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"deferred",errorCode,errorMessage,completedAt:new Date().toISOString()};
}

function uncertainCommand(command:{sequence:number;commandId:string},errorCode:string,errorMessage:string):Record<string,unknown>{
  return {type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"uncertain",errorCode,errorMessage,completedAt:new Date().toISOString()};
}

function restartUnresponsiveWorker(accountId:string,worker:ChildProcess,reason:string):void{
  if(workers.get(accountId)!==worker||unresponsiveWorkers.has(accountId))return;
  unresponsiveWorkers.add(accountId);
  const eventId=`status:${accountId}:${Date.now()}`;
  store.setAccountStatus(accountId,"offline",reason);
  store.enqueueEvent(eventId,"account_status",{eventId,accountId,status:"offline",reason,at:new Date().toISOString()});
  client?.flush();
  window?.webContents.send("agent:event",{type:"status",accountId,status:"offline",reason});
  worker.kill();
}

function normalizeCentralUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("请输入有效的中心平台地址"); }
  const localHttp = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp) throw new Error("公网中心地址必须使用 HTTPS");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("中心地址只填写域名根地址，不要包含路径、参数或账号信息");
  }
  return url.origin;
}

async function startAccount(accountId: string, name: string, dataDir: string): Promise<void> {
  if (workers.has(accountId)) return;
  const proxyUrl = await resolveProxyUrl("https://web.whatsapp.com");
  const worker = fork(join(import.meta.dirname, "account-worker.js"), [], {
    execPath: process.execPath,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  workers.set(accountId, worker);
  let lastWorkerHeartbeat=Date.now();
  const workerWatchdog=setInterval(()=>{
    if(Date.now()-lastWorkerHeartbeat>30_000)restartUnresponsiveWorker(accountId,worker,"账号执行器心跳超时，正在自动重新连接");
  },10_000);
  worker.on("message", (message: Record<string, unknown>) => {
    if(message.type==="worker_heartbeat"){lastWorkerHeartbeat=Date.now();return;}
    if (message.type === "event") {
      const payload = message.payload as Record<string, unknown>;
      const eventId=String(payload.eventId),isNew=!store.hasEvent(eventId);
      store.enqueueEvent(eventId, String(message.kind), payload);
      client?.flush();
      if(isNew&&message.kind==="message"&&message.live===true&&payload.direction==="in")notifyIncomingMessage(accountId,payload);
    }
    if (message.type === "status") {
      const status = String(message.status);
      if(status==="online"||status==="logged_out")qrCodes.delete(accountId);
      const reason = typeof message.reason === "string" ? message.reason : undefined;
      const eventId = `status:${accountId}:${Date.now()}`;
      store.setAccountStatus(accountId, status, reason);
      store.enqueueEvent(eventId, "account_status", { eventId, accountId, status, reason, at: new Date().toISOString() });
      client?.flush();
    }
    if (message.type === "qr") {
      if(removedWorkers.has(accountId)||!store.accounts().some(account=>account.id===accountId))return;
      void QRCode.toDataURL(String(message.qr), { width: 280, margin: 1 }).then((qrDataUrl) => {
        if(removedWorkers.has(accountId)||!store.accounts().some(account=>account.id===accountId))return;
        qrCodes.set(accountId,{dataUrl:qrDataUrl,generatedAt:Date.now()});
        window?.webContents.send("agent:event", { ...message, qrDataUrl });
      });
      return;
    }
    window?.webContents.send("agent:event", message);
  });
  worker.on("exit", () => {
    clearInterval(workerWatchdog);
    workers.delete(accountId);
    if (removedWorkers.delete(accountId)) {
      void rm(join(dataDir,"accounts",accountId),{recursive:true,force:true});
      return;
    }
    if (repairWorkers.delete(accountId)) {
      void resetAccountAuthAndStart(accountId, name, dataDir);
      return;
    }
    if (intentionalRestarts.delete(accountId)) {
      store.setAccountStatus(accountId, "offline", "正在应用代理设置");
      setTimeout(() => void startAccount(accountId, name, dataDir), 500);
      return;
    }
    if (unresponsiveWorkers.delete(accountId)) {
      setTimeout(() => void startAccount(accountId, name, dataDir), 500);
      return;
    }
    store.setAccountStatus(accountId, "error", "worker_exited");
    setTimeout(() => void startAccount(accountId, name, dataDir), 5000);
  });
  worker.send({
    type: "init",
    accountId,
    dataDir: join(dataDir, "accounts"),
    masterKey,
    baseUrl: store.get("baseUrl") ?? DEFAULT_CENTRAL_URL,
    credential: store.get("credential") ?? "",
    proxyUrl,
  });
}

function notifyIncomingMessage(accountId:string,payload:Record<string,unknown>):void{
  const accountName=store.accounts().find(account=>account.id===accountId)?.name??"WhatsApp";
  const sender=typeof payload.senderName==="string"&&payload.senderName.trim()?payload.senderName.trim():accountName;
  const text=typeof payload.text==="string"?payload.text.trim():"";
  const kind=String(payload.kind??"message");
  const body=(text||({image:"[图片]",video:"[视频]",audio:"[语音]",document:"[文件]",sticker:"[贴纸]"} as Record<string,string>)[kind]||"收到一条新消息").slice(0,180);
  const key=attentionKey(accountId,String(payload.chatJid??""));
  startAttention(key);
  if(!Notification.isSupported())return;
  messageNotifications.get(key)?.close();
  const notification=new Notification({
    title:`RelayDesk · ${sender}`,
    subtitle:accountName,
    body,
    icon:APP_ICON_PATH,
    silent:false,
  });
  notification.on("click",()=>{
    showWindow();
  });
  notification.on("close",()=>{if(messageNotifications.get(key)===notification)messageNotifications.delete(key);});
  messageNotifications.set(key,notification);
  notification.show();
}

function attentionKey(accountId:string,chatJid:string):string{return `${accountId}:${chatJid}`;}

async function resetAccountAuthAndStart(accountId:string,name:string,dataDir:string):Promise<void>{
  try{
    await rm(join(dataDir,"accounts",accountId),{recursive:true,force:true});
    store.setAccountStatus(accountId,"pairing");
    await startAccount(accountId,name,dataDir);
  }catch(error){store.setAccountStatus(accountId,"error",error instanceof Error?error.message:String(error));}
}

async function accountRequest(accountId:string,method:"PATCH"|"DELETE",body?:Record<string,unknown>):Promise<void>{
  const baseUrl=store.get("baseUrl")??DEFAULT_CENTRAL_URL;const credential=store.get("credential");if(!credential)throw new Error("设备尚未注册到中心平台");
  const response=await fetch(new URL(`/agent/accounts/${encodeURIComponent(accountId)}`,baseUrl),{method,headers:{authorization:`Bearer ${credential}`,...(body?{"content-type":"application/json"}:{})},body:body?JSON.stringify(body):undefined});
  if(!response.ok)throw new Error(response.status===404?"中心平台尚未部署账号管理接口，或账号不存在":"中心账号操作失败，请检查连接后重试");
}

async function fetchWithRetry(url:URL,init:RequestInit):Promise<Response>{
  let lastError:unknown;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetch(url,{...init,signal:AbortSignal.timeout(15_000)});
      if(![429,502,503,504].includes(response.status)||attempt===2)return response;
      await response.arrayBuffer().catch(()=>undefined);
      lastError=new Error(`HTTP ${response.status}`);
    }catch(error){lastError=error;if(attempt===2)break;}
    await new Promise(resolve=>setTimeout(resolve,500*(2**attempt)+Math.floor(Math.random()*250)));
  }
  const detail=lastError instanceof Error?lastError.message:String(lastError??"unknown_error");
  throw new Error(`无法连接中心账号接口：${detail}`);
}

async function resolveProxyUrl(targetUrl: string): Promise<string | undefined> {
  const mode = store.get("proxyMode") ?? "auto";
  if (mode === "direct") return undefined;
  if (mode === "manual") return normalizeManualProxy(store.get("proxyUrl") ?? "");
  try {
    const rules = await session.defaultSession.resolveProxy(targetUrl);
    for (const rule of rules.split(";")) {
      const [kind, address] = rule.trim().split(/\s+/, 2);
      if ((kind === "PROXY" || kind === "HTTPS") && address) return `http://${address}`;
    }
  } catch {
    // A direct connection remains available when Windows has no usable proxy rule.
  }
  return undefined;
}

async function proxyState(): Promise<{mode:string;url:string;effective:string}> {
  const mode = store.get("proxyMode") ?? "auto";
  const url = store.get("proxyUrl") ?? "";
  const resolved = await resolveProxyUrl("https://web.whatsapp.com");
  const effective = resolved
    ? `${mode === "manual" ? "手动代理" : "系统代理"}：${new URL(resolved).host}`
    : mode === "direct" ? "强制直连" : "直连（未检测到系统代理）";
  return { mode, url, effective };
}

function normalizeManualProxy(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value.trim()); } catch { throw new Error("请输入有效代理地址，例如 http://127.0.0.1:7897"); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || !parsed.port) {
    throw new Error("当前支持带端口的 HTTP/HTTPS 代理，例如 http://127.0.0.1:7897");
  }
  if (parsed.username || parsed.password) throw new Error("当前版本暂不支持需要用户名或密码的代理");
  parsed.pathname = ""; parsed.search = ""; parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function latestQr():{accountId:string;qrDataUrl:string}|null{
  const now=Date.now();
  const accountIds=new Set(store.accounts().map(account=>account.id));
  for(const [accountId,qr] of [...qrCodes].reverse()){
    if(!accountIds.has(accountId)){qrCodes.delete(accountId);continue;}
    if(now-qr.generatedAt<=70_000)return {accountId,qrDataUrl:qr.dataUrl};
    qrCodes.delete(accountId);
  }
  return null;
}

async function loadMasterKey(dataDir: string): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "vault-key.dpapi");
  if (existsSync(path)) {
    const encrypted = await readFile(path);
    return safeStorage.decryptString(encrypted);
  }
  const key = randomBytes(32).toString("hex");
  await writeFile(path, safeStorage.encryptString(key));
  return key;
}
