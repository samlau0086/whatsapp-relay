/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayAgent", {
  state: () => ipcRenderer.invoke("agent:state"),
  diagnostics: () => ipcRenderer.invoke("agent:diagnostics"),
  enroll: (input) => ipcRenderer.invoke("agent:enroll", input),
  updateCentralUrl: (input) => ipcRenderer.invoke("agent:update-central-url", input),
  addAccount: (input) => ipcRenderer.invoke("account:add", input),
  updateAccount: (input) => ipcRenderer.invoke("account:update", input),
  repairAccount: (input) => ipcRenderer.invoke("account:repair", input),
  removeAccount: (input) => ipcRenderer.invoke("account:remove", input),
  saveProxy: (input) => ipcRenderer.invoke("proxy:save", input),
  onEvent: (callback) => ipcRenderer.on("agent:event", (_event, value) => callback(value)),
});
