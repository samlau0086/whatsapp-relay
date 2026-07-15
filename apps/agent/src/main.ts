import { randomBytes } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, safeStorage, session, Tray } from "electron";
import QRCode from "qrcode";
import { AgentStore } from "./store.js";
import { CentralClient } from "./central-client.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_CENTRAL_URL = "https://whatsapp.geekmt.com";
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let store: AgentStore;
let client: CentralClient | undefined;
let masterKey = "";
let quitting = false;
const workers = new Map<string, ChildProcess>();
const intentionalRestarts = new Set<string>();

app.whenReady().then(async () => {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
  const dataDir = app.getPath("userData");
  store = new AgentStore(join(dataDir, "relay-agent.db"));
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
    title: "RelayDesk Agent",
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
  tray.setToolTip("RelayDesk WhatsApp Agent");
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
}));

ipcMain.handle("agent:diagnostics", async () => ({
  generatedAt: new Date().toISOString(),
  appVersion: app.getVersion(),
  protocolVersion: PROTOCOL_VERSION,
  platform: `${process.platform}-${process.arch}`,
  centralConnection: store.get("connection") ?? "offline",
  baseUrl: store.get("baseUrl") ?? "",
  enrolled: Boolean(store.get("credential")),
  accounts: store.accounts().map(({ id, name, status, last_error }) => ({ id, name, status, lastError: last_error })),
  proxy: await proxyState(),
  queue: store.diagnostics(),
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

ipcMain.handle("account:add", async (_event, input: {id:string;name:string}) => {
  const baseUrl = store.get("baseUrl") ?? DEFAULT_CENTRAL_URL;
  const credential = store.get("credential");
  if (!credential) throw new Error("设备尚未注册到中心平台");
  const response = await fetch(new URL("/agent/accounts", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as {error?:string};
    throw new Error(body.error === "account_conflict" ? "账号 ID 已被其他 Agent 使用" : "中心账号登记失败，请检查连接后重试");
  }
  store.upsertAccount(input.id, input.name, "pairing");
  await startAccount(input.id, input.name, app.getPath("userData"));
  return { ok: true };
});

function startCentral(baseUrl: string, agentId: string, credential: string): void {
  client?.stop();
  client = new CentralClient(
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
      store.set("connection", status);
      window?.webContents.send("agent:event", { type: "central_status", status });
    },
  );
  client.start();
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
      const reason = typeof message.reason === "string" ? message.reason : undefined;
      const eventId = `status:${accountId}:${Date.now()}`;
      store.setAccountStatus(accountId, status, reason);
      store.enqueueEvent(eventId, "account_status", { eventId, accountId, status, reason, at: new Date().toISOString() });
      client?.flush();
    }
    if (message.type === "qr") {
      void QRCode.toDataURL(String(message.qr), { width: 280, margin: 1 }).then((qrDataUrl) => {
        window?.webContents.send("agent:event", { ...message, qrDataUrl });
      });
      return;
    }
    window?.webContents.send("agent:event", message);
  });
  worker.on("exit", () => {
    workers.delete(accountId);
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
