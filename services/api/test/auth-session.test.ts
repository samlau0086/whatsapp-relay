import assert from "node:assert/strict";
import test from "node:test";
import { authorizedFetch, SESSION_EXPIRED_EVENT, setCurrentAccessToken } from "../../../app/auth-session.ts";

function storage() {
  const values = new Map<string,string>();
  return {
    getItem:(key:string)=>values.get(key)??null,
    removeItem:(key:string)=>void values.delete(key),
    setItem:(key:string,value:string)=>void values.set(key,value),
  };
}

function token(exp:number) {
  const payload=Buffer.from(JSON.stringify({sub:"user",exp})).toString("base64url");
  return `header.${payload}.signature`;
}

test("authorized requests refresh expiring tokens once before concurrent API calls",async()=>{
  const originalFetch=globalThis.fetch;
  const local=storage(),session=storage(),requests:Array<{url:string;authorization:string}>=[];
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:local});
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:session});
  const expired=token(Math.floor(Date.now()/1000)-1),fresh=token(Math.floor(Date.now()/1000)+900);
  let refreshes=0;
  globalThis.fetch=async(input,init)=>{
    const url=String(input);
    if(url.endsWith("/api/v1/auth/refresh")){
      refreshes++;
      await new Promise(resolve=>setTimeout(resolve,10));
      return Response.json({accessToken:fresh});
    }
    requests.push({url,authorization:String((init?.headers as Record<string,string>)?.authorization??"")});
    return Response.json({ok:true});
  };
  try{
    setCurrentAccessToken(expired);
    const results=await Promise.all([authorizedFetch("/api/one",expired),authorizedFetch("/api/two",expired)]);
    assert.equal(refreshes,1);
    assert.deepEqual(requests.map(item=>item.url),["/api/one","/api/two"]);
    assert.ok(requests.every(item=>item.authorization===`Bearer ${fresh}`));
    assert.ok(results.every(item=>item.response.ok&&item.token===fresh));
    assert.equal(session.getItem("relayAccessToken"),fresh);
  }finally{
    globalThis.fetch=originalFetch;
    Reflect.deleteProperty(globalThis,"localStorage");
    Reflect.deleteProperty(globalThis,"sessionStorage");
  }
});

test("an expired session avoids protected requests and emits one expiry event",async()=>{
  const originalFetch=globalThis.fetch,originalWindow=Reflect.get(globalThis,"window");
  const local=storage(),session=storage(),events=new EventTarget();
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:local});
  Object.defineProperty(globalThis,"sessionStorage",{configurable:true,value:session});
  Object.defineProperty(globalThis,"window",{configurable:true,value:events});
  const expired=token(Math.floor(Date.now()/1000)-1);
  let refreshes=0,protectedRequests=0,expiryEvents=0;
  events.addEventListener(SESSION_EXPIRED_EVENT,()=>expiryEvents++);
  globalThis.fetch=async(input)=>{
    if(String(input).endsWith("/api/v1/auth/refresh")){refreshes++;return Response.json({error:"invalid_refresh"},{status:401});}
    protectedRequests++;
    return Response.json({ok:true});
  };
  try{
    setCurrentAccessToken(expired);
    const results=await Promise.all([authorizedFetch("/api/one",expired),authorizedFetch("/api/two",expired)]);
    assert.equal(refreshes,1);
    assert.equal(protectedRequests,0);
    assert.equal(expiryEvents,1);
    assert.ok(results.every(item=>item.response.status===401));
  }finally{
    globalThis.fetch=originalFetch;
    if(originalWindow===undefined)Reflect.deleteProperty(globalThis,"window");else Object.defineProperty(globalThis,"window",{configurable:true,value:originalWindow});
    Reflect.deleteProperty(globalThis,"localStorage");
    Reflect.deleteProperty(globalThis,"sessionStorage");
  }
});
