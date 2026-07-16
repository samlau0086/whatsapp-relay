import WebSocket from "ws";
import { AgentStore } from "./store.js";

type CommandHandler = (command:{sequence:number;commandId:string;accountId:string;command:string;payload:Record<string,unknown>})=>Promise<Record<string,unknown>>;

export class CentralClient {
  private socket?:WebSocket; private retry=0; private stopped=false; private heartbeat?:NodeJS.Timeout;
  constructor(private store:AgentStore,private baseUrl:string,private agentId:string,private credential:string,private agentVersion:string,private protocolVersion:number,private onCommand:CommandHandler,private onStatus:(value:string)=>void){}
  start():void{this.stopped=false;this.connect();}
  stop():void{this.stopped=true;clearInterval(this.heartbeat);this.socket?.close();}
  flush():void{
    if(this.socket?.readyState!==WebSocket.OPEN)return;
    const events=this.store.pendingEvents();if(!events.length)return;
    this.socket.send(JSON.stringify({type:"event_batch",fromCursor:events[0].cursor,toCursor:events[events.length-1].cursor,events:events.map((event)=>({cursor:event.cursor,kind:event.event_kind,payload:JSON.parse(event.payload)}))}));
  }
  private connect():void{
    const url=new URL("/agent/ws",this.baseUrl.replace(/^http/,"ws"));
    this.socket=new WebSocket(url,{headers:{authorization:`Bearer ${this.credential}`}});
    this.socket.on("open",()=>{this.retry=0;this.onStatus("online");this.socket?.send(JSON.stringify({type:"hello",protocolVersion:this.protocolVersion,agentId:this.agentId,agentVersion:this.agentVersion,platform:`win32-${process.arch}`,lastAckedCursor:Number(this.store.get("lastAckedCursor")??0)}));this.heartbeat=setInterval(()=>{this.socket?.send(JSON.stringify({type:"heartbeat",at:new Date().toISOString(),accounts:this.store.accounts().map((account)=>({accountId:account.id,status:account.status,queueDepth:0}))}));this.flush();},10_000);this.flush();});
    this.socket.on("message",(data)=>void this.handle(JSON.parse(data.toString())));
    this.socket.on("close",()=>{clearInterval(this.heartbeat);this.onStatus("offline");if(!this.stopped)setTimeout(()=>this.connect(),this.nextDelay());});
    this.socket.on("error",()=>this.socket?.close());
  }
  private async handle(frame:Record<string,unknown>):Promise<void>{
    if(frame.type==="ack"){this.store.ack(Number(frame.cursor));this.store.set("lastSyncError","");this.flush();return;}
    if(frame.type==="error"){this.store.set("lastSyncError",JSON.stringify({code:frame.code,cursor:frame.cursor,detail:frame.detail,at:new Date().toISOString()}));return;}
    if(frame.type==="incompatible"){this.onStatus("incompatible");this.stop();return;}
    if(frame.type!=="command")return;
    const command=frame as {type:string;sequence:number;commandId:string;accountId:string;command:string;payload:Record<string,unknown>};
    const prior=this.store.priorResult(command.commandId);if(prior){this.socket?.send(JSON.stringify(prior));return;}
    this.store.saveCommand(command.sequence,command.commandId,command.accountId,command);
    let result:Record<string,unknown>;
    try{result=await this.onCommand(command);}catch(error){result={type:"command_result",sequence:command.sequence,commandId:command.commandId,outcome:"uncertain",errorCode:"executor_interrupted",errorMessage:error instanceof Error?error.message:String(error),completedAt:new Date().toISOString()};}
    if(result.outcome==="deferred")this.store.deferCommand(command.commandId);else this.store.completeCommand(command.commandId,result);
    this.socket?.send(JSON.stringify(result));
  }
  private nextDelay():number{this.retry++;const base=Math.min(60_000,1000*2**Math.min(this.retry,6));return Math.round(base*(.75+Math.random()*.5));}
}
