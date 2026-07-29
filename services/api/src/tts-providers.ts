export const TTS_PROVIDERS=["openai","elevenlabs","azure","openai_compatible"] as const;
export type TtsProvider=typeof TTS_PROVIDERS[number];

export type TtsProviderSetting={
  provider:TtsProvider;
  apiKey:string;
  baseUrl:string;
  model:string;
  voice:string;
};

export type GeneratedSpeech={bytes:Buffer;mimeType:string;extension:string};

export class TtsProviderHttpError extends Error{
  constructor(public readonly status:number,public readonly providerMessage:string){
    super(`Provider HTTP ${status}${providerMessage?`: ${providerMessage}`:""}`);
    this.name="TtsProviderHttpError";
  }
}

const defaults:Record<TtsProvider,Omit<TtsProviderSetting,"provider"|"apiKey">>={
  openai:{baseUrl:"https://api.openai.com/v1",model:"gpt-4o-mini-tts",voice:"coral"},
  elevenlabs:{baseUrl:"https://api.elevenlabs.io/v1",model:"eleven_multilingual_v2",voice:"JBFqnCBsd6RMkjVDRZzb"},
  azure:{baseUrl:"",model:"",voice:"zh-CN-XiaoxiaoNeural"},
  openai_compatible:{baseUrl:"",model:"",voice:""},
};

export function ttsProviderDefaults(provider:TtsProvider){return defaults[provider];}

export async function generateSpeech(setting:TtsProviderSetting,input:{text:string;speed:number;instructions?:string}):Promise<GeneratedSpeech>{
  if(setting.provider==="azure")return generateAzure(setting,input);
  if(setting.provider==="elevenlabs")return generateElevenLabs(setting,input);
  return setting.provider==="openai"?generateOpenAi(setting,input):generateOpenAiCompatible(setting,input);
}

async function generateOpenAi(setting:TtsProviderSetting,input:{text:string;speed:number;instructions?:string}):Promise<GeneratedSpeech>{
  const response=await fetch(`${trimSlash(setting.baseUrl)}/audio/speech`,{method:"POST",headers:{authorization:`Bearer ${setting.apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:setting.model,input:input.text,voice:setting.voice,speed:input.speed,response_format:"opus",...(input.instructions&&!setting.model.startsWith("tts-1")?{instructions:input.instructions}:{})}),signal:AbortSignal.timeout(90_000)});
  return audioResponse(response,"audio/ogg; codecs=opus","ogg");
}

async function generateOpenAiCompatible(setting:TtsProviderSetting,input:{text:string;speed:number;instructions?:string}):Promise<GeneratedSpeech>{
  const request=async(includeInstructions:boolean,includeFormat:boolean)=>fetch(`${trimSlash(setting.baseUrl)}/audio/speech`,{method:"POST",headers:{authorization:`Bearer ${setting.apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:setting.model,input:input.text,voice:setting.voice,speed:input.speed,...(includeFormat?{response_format:"mp3"}:{}),...(includeInstructions&&input.instructions?{instructions:input.instructions}:{})}),signal:AbortSignal.timeout(90_000)});
  let response=await request(Boolean(input.instructions),true);
  if(isCompatibilityRequestError(response)&&input.instructions){await response.body?.cancel();response=await request(false,true);}
  if(isCompatibilityRequestError(response)){await response.body?.cancel();response=await request(false,false);}
  return audioResponse(response,"audio/mpeg","mp3");
}

async function generateElevenLabs(setting:TtsProviderSetting,input:{text:string;speed:number}):Promise<GeneratedSpeech>{
  const url=`${trimSlash(setting.baseUrl)}/text-to-speech/${encodeURIComponent(setting.voice)}?output_format=mp3_44100_128`;
  const response=await fetch(url,{method:"POST",headers:{"xi-api-key":setting.apiKey,"content-type":"application/json"},body:JSON.stringify({text:input.text,model_id:setting.model,voice_settings:{speed:Math.min(1.2,Math.max(.7,input.speed))}}),signal:AbortSignal.timeout(90_000)});
  return audioResponse(response,"audio/mpeg","mp3");
}

async function generateAzure(setting:TtsProviderSetting,input:{text:string;speed:number}):Promise<GeneratedSpeech>{
  const locale=/^[a-z]{2}-[A-Z]{2}/.exec(setting.voice)?.[0]??"zh-CN",rate=`${Math.round((input.speed-1)*100)}%`;
  const ssml=`<speak version="1.0" xml:lang="${locale}"><voice name="${escapeXml(setting.voice)}"><prosody rate="${rate}">${escapeXml(input.text)}</prosody></voice></speak>`;
  const response=await fetch(`${trimSlash(setting.baseUrl)}/cognitiveservices/v1`,{method:"POST",headers:{"Ocp-Apim-Subscription-Key":setting.apiKey,"content-type":"application/ssml+xml","X-Microsoft-OutputFormat":"ogg-24khz-16bit-mono-opus","User-Agent":"RelayDesk"},body:ssml,signal:AbortSignal.timeout(90_000)});
  return audioResponse(response,"audio/ogg; codecs=opus","ogg");
}

async function audioResponse(response:Response,mimeType:string,extension:string):Promise<GeneratedSpeech>{
  if(!response.ok)throw new TtsProviderHttpError(response.status,await providerErrorMessage(response));
  const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length)throw new Error("Provider returned empty audio");
  const detected=audioType(response.headers.get("content-type"));
  return{bytes,mimeType:detected?.mimeType??mimeType,extension:detected?.extension??extension};
}

export function ttsProviderFailureMessage(error:unknown):string{
  if(error instanceof TtsProviderHttpError){
    if(error.status===401||error.status===403)return"语音 Provider 鉴权失败，请检查 API Key";
    if(error.status===404)return`语音接口、模型或音色不存在${error.providerMessage?`：${error.providerMessage}`:""}`;
    if(error.status===429)return"语音 Provider 请求过于频繁或额度不足，请稍后重试";
    return`语音 Provider 拒绝了请求（HTTP ${error.status}）${error.providerMessage?`：${error.providerMessage}`:""}`;
  }
  if(error instanceof DOMException&&error.name==="TimeoutError")return"语音 Provider 响应超时，请稍后重试";
  if(error instanceof TypeError)return"无法连接语音 Provider，请检查 API Endpoint 和网络";
  return"AI 语音生成失败，请检查 Provider 配置或稍后重试";
}

const isCompatibilityRequestError=(response:Response)=>[400,415,422].includes(response.status);
const audioType=(contentType:string|null)=>{
  const type=contentType?.split(";")[0].trim().toLowerCase();
  return type==="audio/mpeg"||type==="audio/mp3"?{mimeType:"audio/mpeg",extension:"mp3"}:type==="audio/ogg"||type==="application/ogg"?{mimeType:"audio/ogg; codecs=opus",extension:"ogg"}:type==="audio/wav"||type==="audio/wave"||type==="audio/x-wav"?{mimeType:"audio/wav",extension:"wav"}:type==="audio/webm"?{mimeType:"audio/webm",extension:"webm"}:type==="audio/mp4"||type==="audio/aac"?{mimeType:type,extension:type==="audio/aac"?"aac":"m4a"}:null;
};
async function providerErrorMessage(response:Response):Promise<string>{
  const raw=(await response.text()).slice(0,2000).trim();if(!raw)return"";
  try{
    const parsed=JSON.parse(raw) as {error?:unknown;message?:unknown;detail?:unknown};
    const error=parsed.error;
    const message=typeof error==="object"&&error!==null&&"message" in error?(error as {message?:unknown}).message:typeof error==="string"?error:parsed.message??parsed.detail;
    return typeof message==="string"?cleanProviderMessage(message):"";
  }catch{return cleanProviderMessage(raw.replace(/<[^>]+>/g," "));}
}
const cleanProviderMessage=(value:string)=>value.replace(/\s+/g," ").replace(/(?:sk|key|token|bearer)[-_ ]?[a-z0-9._-]{8,}/gi,"[已隐藏凭据]").trim().slice(0,300);
const trimSlash=(value:string)=>value.replace(/\/+$/,"");
const escapeXml=(value:string)=>value.replace(/[<>&"']/g,char=>({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&apos;"}[char]??char));
