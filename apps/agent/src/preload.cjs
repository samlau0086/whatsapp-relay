/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("relayAgent", {
  state: () => ipcRenderer.invoke("agent:state"),
  diagnostics: () => ipcRenderer.invoke("agent:diagnostics"),
  enroll: (input) => ipcRenderer.invoke("agent:enroll", input),
  addAccount: (input) => ipcRenderer.invoke("account:add", input),
  onEvent: (callback) => ipcRenderer.on("agent:event", (_event, value) => callback(value)),
});
