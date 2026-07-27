import {mkdir,writeFile} from "node:fs/promises";

const base=process.env.PERF_API_URL??"http://127.0.0.1:18080";
const out=process.env.PERF_ARTIFACT_DIR??"performance-artifacts";
await mkdir(out,{recursive:true});
const login=await fetch(`${base}/api/v1/auth/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:"perf@example.test",password:"Performance123!"})});
if(!login.ok)throw new Error(`login failed: ${login.status}`);
const {accessToken}=await login.json();
const headers={authorization:`Bearer ${accessToken}`};
const timed=async path=>{const started=performance.now();const response=await fetch(`${base}${path}`,{headers});const body=await response.json().catch(()=>({}));return{ms:performance.now()-started,status:response.status,body};};
const percentile=(values,p)=>values.toSorted((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]??0;
const benchmark=async(name,path,samples=40)=>{
  const values=[];let errors=0;const failureSamples=[];
  for(let offset=0;offset<samples;offset+=10){
    const batch=await Promise.all(Array.from({length:Math.min(10,samples-offset)},()=>timed(path)));
    for(const result of batch){values.push(result.ms);if(result.status!==200){errors++;if(failureSamples.length<5)failureSamples.push({status:result.status,body:result.body});}}
  }
  return{name,path,samples,p50:percentile(values,.5),p95:percentile(values,.95),max:Math.max(...values),errors,errorRate:errors/samples,failureSamples,latenciesMs:values};
};
const warmup=async(path,samples=30)=>{
  for(let offset=0;offset<samples;offset+=10){
    const batch=await Promise.all(Array.from({length:Math.min(10,samples-offset)},()=>timed(path)));
    const failure=batch.find(result=>result.status!==200);
    if(failure)throw new Error(`warmup failed: HTTP ${failure.status} ${JSON.stringify(failure.body)}`);
  }
};

let cursorPath="/api/v1/conversations?limit=40";
for(let page=0;page<100;page++){
  const result=await timed(cursorPath);
  if(result.status!==200)throw new Error(`deep cursor preparation failed on page ${page+1}: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  if(!result.body.nextCursor)break;
  cursorPath=`/api/v1/conversations?limit=40&cursor=${encodeURIComponent(result.body.nextCursor)}`;
}
// Exercise concurrent connections and let PostgreSQL/Node reach steady state before
// enforcing the list-query SLO. Warmup requests are deliberately excluded from
// percentile samples, but any HTTP failure still fails the performance job.
await warmup("/api/v1/conversations?limit=40");
const results=[];
results.push(await benchmark("first_page","/api/v1/conversations?limit=40"));
results.push(await benchmark("deep_cursor",cursorPath));
results.push(await benchmark("mine","/api/v1/conversations?filter=mine&limit=40"));
results.push(await benchmark("favorite","/api/v1/conversations?filter=favorite&limit=40"));
results.push(await benchmark("contact_search","/api/v1/conversations?q=Contact%209999&limit=40"));
results.push(await benchmark("summary_search","/api/v1/conversations?q=summary%209999&limit=40"));
results.push(await benchmark("counts","/api/v1/conversations/counts"));

const first=await timed("/api/v1/conversations?limit=1");
const conversationId=first.body.data?.[0]?.id;
if(!conversationId)throw new Error("seeded conversation unavailable");
const sockets=await Promise.all(Array.from({length:50},async()=>{
  const ticketResponse=await fetch(`${base}/api/v1/events/ticket`,{method:"POST",headers});
  const ticket=await ticketResponse.json();
  const url=new URL(ticket.websocketPath,base);url.protocol="ws:";url.searchParams.set("ticket",ticket.ticket);
  const socket=new WebSocket(url);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  return socket;
}));
const eventStart=performance.now();
const deliveries=sockets.map(socket=>new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>reject(new Error("websocket delivery timeout")),5000);
  socket.addEventListener("message",event=>{const frame=JSON.parse(String(event.data));if(frame.type==="conversation.changed"&&frame.conversationId===conversationId){clearTimeout(timeout);resolve(performance.now()-eventStart);}},{once:false});
}));
const mutation=await fetch(`${base}/api/v1/conversations/${conversationId}`,{method:"PATCH",headers:{...headers,"content-type":"application/json"},body:JSON.stringify({favorite:true})});
if(!mutation.ok)throw new Error(`event mutation failed: ${mutation.status}`);
const settledDeliveries=await Promise.allSettled(deliveries);
const websocketValues=settledDeliveries.filter(item=>item.status==="fulfilled").map(item=>item.value);
const websocketErrors=settledDeliveries.filter(item=>item.status==="rejected").length;
for(const socket of sockets)socket.close();
const websocket={name:"websocket",clients:50,p50:percentile(websocketValues,.5),p95:percentile(websocketValues,.95),max:Math.max(0,...websocketValues),errors:websocketErrors,errorRate:websocketErrors/50,latenciesMs:websocketValues};
const report={generatedAt:new Date().toISOString(),scale:{accounts:10,conversations:100000,messages:1000000},http:results,websocket};
await writeFile(`${out}/performance.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
const firstPage=results.find(item=>item.name==="first_page");
const searches=results.filter(item=>item.name.endsWith("_search"));
const counts=results.find(item=>item.name==="counts");
const failed=results.some(item=>item.errors)||firstPage.p95>300||searches.some(item=>item.p95>600)||counts.p95>800||websocket.p95>1000||websocket.errors;
if(failed)process.exitCode=1;
