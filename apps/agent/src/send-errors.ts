const TRANSIENT_CODES=new Set([1006,1011,408,425,428,429,502,503,504]);

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
