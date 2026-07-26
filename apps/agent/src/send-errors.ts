const TRANSIENT_CODES=new Set([1006,1011,408,425,428,429,502,503,504]);
const SEND_CONFIRMATION_TIMEOUT="SEND_CONFIRMATION_TIMEOUT";
const CENTRAL_MEDIA_AUTHORIZATION_ERROR="CENTRAL_MEDIA_AUTHORIZATION_ERROR";

export function waitForSendConfirmation<T>(operation:Promise<T>,timeoutMs:number):Promise<T>{
  return new Promise<T>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(new Error(`WhatsApp send confirmation timed out after ${Math.round(timeoutMs/1000)} seconds`),{code:SEND_CONFIRMATION_TIMEOUT})),timeoutMs);
    operation.then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}

export function isSendConfirmationTimeout(error:unknown):boolean{
  return (error as {code?:unknown}|null)?.code===SEND_CONFIRMATION_TIMEOUT;
}

export function centralMediaAuthorizationError(statusCode:number):Error {
  return Object.assign(new Error(`Media download authorization is temporarily unavailable: HTTP ${statusCode}`),{code:CENTRAL_MEDIA_AUTHORIZATION_ERROR,statusCode});
}

export function isCentralMediaAuthorizationError(error:unknown):boolean {
  return (error as {code?:unknown}|null)?.code===CENTRAL_MEDIA_AUTHORIZATION_ERROR;
}

export function isTransientSendConnectionError(error:unknown):boolean {
  const value=error as {message?:unknown;code?:unknown;statusCode?:unknown;output?:{statusCode?:unknown};cause?:{code?:unknown;message?:unknown}}|undefined;
  const values=[value?.code,value?.statusCode,value?.output?.statusCode,value?.cause?.code];
  if(values.some(item=>TRANSIENT_CODES.has(Number(item))))return true;
  const message=[value?.message,value?.cause?.message,error].map(item=>String(item??"")).join(" ").toLowerCase();
  if([...TRANSIENT_CODES].some(code=>new RegExp(`(^|\\D)${code}(\\D|$)`).test(message)))return true;
  return /fetch failed|connection (?:closed|terminated|lost)|socket (?:closed|hang up)|econnreset|econnrefused|etimedout|epipe|network timeout|connect timeout|headers timeout|body timeout/.test(message);
}

export function describeSendError(error:unknown):string {
  const value=error as {message?:unknown;code?:unknown;cause?:{message?:unknown;code?:unknown}}|undefined;
  const parts=[value?.message,value?.code,value?.cause?.message,value?.cause?.code]
    .map(item=>String(item??"").trim()).filter(Boolean);
  return [...new Set(parts)].join("; ")||String(error);
}
