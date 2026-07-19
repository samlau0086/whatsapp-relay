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
  return generateOpenAiCompatible(setting,input);
}

async function generateOpenAiCompatible(setting:TtsProviderSetting,input:{text:string;speed:number;instructions?:string}):Promise<GeneratedSpeech>{
  const response=await fetch(`${trimSlash(setting.baseUrl)}/audio/speech`,{method:"POST",headers:{authorization:`Bearer ${setting.apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:setting.model,input:input.text,voice:setting.voice,speed:input.speed,response_format:"opus",...(input.instructions&&!setting.model.startsWith("tts-1")?{instructions:input.instructions}:{})}),signal:AbortSignal.timeout(90_000)});
  return audioResponse(response,"audio/ogg; codecs=opus","ogg");
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
  if(!response.ok)throw new Error(`Provider HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
  const bytes=Buffer.from(await response.arrayBuffer());if(!bytes.length)throw new Error("Provider returned empty audio");
  return{bytes,mimeType,extension};
}

const trimSlash=(value:string)=>value.replace(/\/+$/,"");
const escapeXml=(value:string)=>value.replace(/[<>&"']/g,char=>({"<":"&lt;",">":"&gt;","&":"&amp;","\"":"&quot;","'":"&apos;"}[char]??char));
