const FRANKFURTER_RATES_URL="https://api.frankfurter.dev/v2/rates";

type FrankfurterRate={date?:unknown;base?:unknown;quote?:unknown;rate?:unknown};

export type ExchangeRateResult={date:string;rates:Record<string,number>};

export async function fetchLatestExchangeRates(baseCurrency:string,currencies:string[],fetcher:typeof fetch=fetch):Promise<ExchangeRateResult>{
  const base=baseCurrency.trim().toUpperCase(),quotes=[...new Set(currencies.map(code=>code.trim().toUpperCase()).filter(code=>code!==base))];
  if(!quotes.length)return{date:new Date().toISOString().slice(0,10),rates:{[base]:1}};
  const url=new URL(FRANKFURTER_RATES_URL);url.searchParams.set("base",base);url.searchParams.set("quotes",quotes.join(","));
  let response:Response;
  try{response=await fetcher(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)});}catch{throw new Error("公共汇率服务暂时无法连接，请稍后重试");}
  const body=await response.json().catch(()=>null) as FrankfurterRate[]|{message?:unknown}|null;
  if(!response.ok){const message=body&&!Array.isArray(body)&&typeof body.message==="string"?body.message:"上游服务返回异常";throw new Error(`公共汇率服务请求失败：${message}`);}
  if(!Array.isArray(body))throw new Error("公共汇率服务返回了无法识别的数据");
  const rates:Record<string,number>={[base]:1};let date="";
  for(const item of body){const quote=typeof item.quote==="string"?item.quote.toUpperCase():"",rate=Number(item.rate);if(quotes.includes(quote)&&Number.isFinite(rate)&&rate>0){rates[quote]=rate;if(typeof item.date==="string"&&item.date>date)date=item.date;}}
  const missing=quotes.filter(code=>rates[code]===undefined);if(missing.length)throw new Error(`公共汇率服务不支持以下币种：${missing.join("、")}`);
  return{date:date||new Date().toISOString().slice(0,10),rates};
}
