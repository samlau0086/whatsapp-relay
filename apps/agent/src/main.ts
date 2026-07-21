import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, session, Tray } from "electron";
import QRCode from "qrcode";
import { AgentStore } from "./store.js";
import { CentralClient } from "./central-client.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_CENTRAL_URL = "https://wsdesk.geekmt.com";
const STABLE_USER_DATA = join(app.getPath("appData"), "@relaydesk", "windows-agent");
mkdirSync(STABLE_USER_DATA,{recursive:true});
app.setPath("userData", STABLE_USER_DATA);
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let store: AgentStore;
let client: CentralClient | undefined;
let masterKey = "";
let quitting = false;
const workers = new Map<string, ChildProcess>();
const intentionalRestarts = new Set<string>();
const removedWorkers = new Set<string>();
const repairWorkers = new Set<string>();
const qrCodes = new Map<string,{dataUrl:string;generatedAt:number}>();

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

function createWindow(): void {
  window = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 620,
    minHeight: 520,
    title: `RelayDesk Agent v${app.getVersion()}`,
    backgroundColor: "#f4f7f5",
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void window.loadFile(join(import.meta.dirname, "renderer", "index.html"));
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
}

function createTray(): void {
  const traySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#167b50"/><path d="M9 10h14v9H15l-5 4v-4H9z" fill="white"/><circle cx="13" cy="14.5" r="1" fill="#167b50"/><circle cx="16" cy="14.5" r="1" fill="#167b50"/><circle cx="19" cy="14.5" r="1" fill="#167b50"/></svg>`;
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(traySvg)}`).resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(`RelayDesk WhatsApp Agent v${app.getVersion()}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 RelayDesk Agent", click: () => window?.show() },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("double-click", () => window?.show());
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
    PROTOCOL_VERSION,
    async (command) => {
      const worker = workers.get(command.accountId);
      if (!worker) throw new Error("Account worker unavailable");
      return await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Command timed out after 90 seconds")), 90_000);
        const handler = (message: Record<string, unknown>) => {
          if (message.type === "command_result" && message.commandId === command.commandId) {
            clearTimeout(timeout);
            worker.off("message", handler);
            resolve(message);
          }
        };
        worker.on("message", handler);
        worker.send({ type: "command", ...command });
      });
    },
    (status) => {
      if (client !== nextClient) return;
      store.set("connection", status);
      window?.webContents.send("agent:event", { type: "central_status", status });
    },
  );
  client = nextClient;
  nextClient.start();
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
  worker.on("message", (message: Record<string, unknown>) => {
    if (message.type === "event") {
      const payload = message.payload as Record<string, unknown>;
      store.enqueueEvent(String(payload.eventId), String(message.kind), payload);
      client?.flush();
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
