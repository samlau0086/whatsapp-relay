import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("relayAgent",{state:()=>ipcRenderer.invoke("agent:state"),enroll:(input:unknown)=>ipcRenderer.invoke("agent:enroll",input),addAccount:(input:unknown)=>ipcRenderer.invoke("account:add",input),onEvent:(callback:(value:unknown)=>void)=>ipcRenderer.on("agent:event",(_event,value)=>callback(value))});
