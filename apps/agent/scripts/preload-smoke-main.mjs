import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

const expectedMethods = ["state", "diagnostics", "enroll", "addAccount", "updateAccount", "repairAccount", "removeAccount", "saveProxy", "onEvent"];
app.disableHardwareAcceleration();
const timeout = setTimeout(() => {
  console.error("Preload smoke test timed out");
  app.exit(1);
}, 45_000);

ipcMain.handle("agent:state", () => ({baseUrl:"https://relay.test",enrolled:true,connection:"online",version:"smoke",protocolVersion:1,accounts:[{id:"account-smoke",name:"测试账号",status:"online"}],proxy:{mode:"auto",url:"",effective:"系统代理：127.0.0.1:7897"}}));
ipcMain.handle("agent:diagnostics", () => ({ok:true}));
ipcMain.handle("agent:enroll", () => ({ok:true}));
ipcMain.handle("account:add", () => ({ok:true}));
ipcMain.handle("account:update", () => ({ok:true}));
ipcMain.handle("account:repair", () => ({ok:true}));
ipcMain.handle("account:remove", () => ({ok:true}));
ipcMain.handle("proxy:save", () => ({ok:true}));

console.log("Waiting for Electron app readiness");
app.whenReady().then(async () => {
  console.log("Electron app ready; creating hidden window");
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "..", "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.on("did-fail-load", (_event, code, description) => console.error(`Page load failed: ${code} ${description}`));
  await window.loadFile(join(import.meta.dirname, "..", "dist", "renderer", "index.html"));
  console.log("Smoke page loaded; checking bridge");
  const exposed = await window.webContents.executeJavaScript("Object.keys(window.relayAgent ?? {}).sort()");
  const missing = expectedMethods.filter((method) => !exposed.includes(method));
  const addFormOpened = await window.webContents.executeJavaScript("document.getElementById('add-account').click(); !document.getElementById('add-account-form').classList.contains('hidden')");
  const editFormOpened = await window.webContents.executeJavaScript(`(async()=>{document.querySelector('[data-action="edit"]').click();await new Promise(resolve=>setTimeout(resolve,50));return !document.getElementById('edit-account-form').classList.contains('hidden')&&document.getElementById('edit-account-name').value==='测试账号'&&document.getElementById('add-account-form').classList.contains('hidden')})()`);
  const proxyControlsReady = await window.webContents.executeJavaScript("document.getElementById('proxy-mode').value === 'auto' && document.getElementById('proxy-effective').textContent.includes('系统代理')");
  const staleQrHidden = await window.webContents.executeJavaScript("document.getElementById('qr-wrap').classList.contains('hidden') && document.getElementById('qr').getAttribute('src') === ''");
  clearTimeout(timeout);
  if (missing.length || !addFormOpened || !editFormOpened || !proxyControlsReady || !staleQrHidden) {
    if (!addFormOpened) console.error("Add-account form did not open");
    if (!editFormOpened) console.error("Edit-account form did not open with the existing account name");
    if (!proxyControlsReady) console.error("Proxy controls did not initialize");
    if (!staleQrHidden) console.error("Stale QR was not cleared");
    console.error(`Preload bridge is missing: ${missing.join(", ")}`);
    app.exit(1);
  } else {
    console.log(`Preload bridge ready: ${exposed.join(", ")}`);
    app.exit(0);
  }
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
