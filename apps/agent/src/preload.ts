import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("relayAgent",{
  state:()=>ipcRenderer.invoke("agent:state"),
  diagnostics:()=>ipcRenderer.invoke("agent:diagnostics"),
  enroll:(input:unknown)=>ipcRenderer.invoke("agent:enroll",input),
  addAccount:(input:unknown)=>ipcRenderer.invoke("account:add",input),
  onEvent:(callback:(value:unknown)=>void)=>ipcRenderer.on("agent:event",(_event,value)=>callback(value)),
});
