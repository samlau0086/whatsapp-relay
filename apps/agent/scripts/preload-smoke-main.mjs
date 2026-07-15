import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";

const expectedMethods = ["state", "diagnostics", "enroll", "addAccount", "onEvent"];
app.disableHardwareAcceleration();
const timeout = setTimeout(() => {
  console.error("Preload smoke test timed out");
  app.exit(1);
}, 45_000);

for (const channel of ["agent:state", "agent:diagnostics", "agent:enroll", "account:add"]) {
  ipcMain.handle(channel, () => ({ ok: true }));
}

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
  await window.loadURL("data:text/html,<html><body>RelayDesk preload smoke test</body></html>");
  console.log("Smoke page loaded; checking bridge");
  const exposed = await window.webContents.executeJavaScript("Object.keys(window.relayAgent ?? {}).sort()");
  const missing = expectedMethods.filter((method) => !exposed.includes(method));
  clearTimeout(timeout);
  if (missing.length) {
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
