import { setTimeout as sleep } from "node:timers/promises";

const TRANSIENT_DATABASE_CODES=new Set(["ECONNREFUSED","ECONNRESET","EPIPE","ETIMEDOUT","08001","08003","08006","57P01","57P02","57P03"]);

export function isTransientDatabaseStartupError(error:unknown):boolean{
  let current:unknown=error;
  for(let depth=0;depth<4&&current&&typeof current==="object";depth++){
    const value=current as {code?:unknown;cause?:unknown};
    if(TRANSIENT_DATABASE_CODES.has(String(value.code??"")))return true;
    current=value.cause;
  }
  return false;
}

export async function retryDatabaseStartup<T>(operation:()=>Promise<T>,options:{attempts?:number;baseDelayMs?:number;sleep?:(delayMs:number)=>Promise<void>;onRetry?:(error:unknown,attempt:number,delayMs:number)=>void}={}):Promise<T>{
  const attempts=Math.max(1,options.attempts??10),baseDelayMs=Math.max(0,options.baseDelayMs??250),wait=options.sleep??(delayMs=>sleep(delayMs));
  for(let attempt=1;;attempt++){
    try{return await operation();}catch(error){
      if(attempt>=attempts||!isTransientDatabaseStartupError(error))throw error;
      const delayMs=Math.min(2_000,baseDelayMs*2**(attempt-1));
      options.onRetry?.(error,attempt,delayMs);
      await wait(delayMs);
    }
  }
}
