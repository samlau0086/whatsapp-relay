export const TRANSLATION_PROVIDERS=["openai","openai_compatible"] as const;
export type TranslationProvider=typeof TRANSLATION_PROVIDERS[number];

export type TranslationProviderSetting={
  provider:TranslationProvider;
  apiKey:string;
  baseUrl:string;
  model:string;
  transcriptionModel:string;
};

const defaults:Record<TranslationProvider,Omit<TranslationProviderSetting,"provider"|"apiKey">>={
  openai:{baseUrl:"https://api.openai.com/v1",model:"gpt-5.6-luna",transcriptionModel:"gpt-4o-mini-transcribe"},
  openai_compatible:{baseUrl:"",model:"",transcriptionModel:"gpt-4o-mini-transcribe"},
};

export function translationProviderDefaults(provider:TranslationProvider){return defaults[provider];}

export async function translateText(setting:TranslationProviderSetting,input:{text:string;targetLanguage:string}):Promise<string>{
  return requestTranslation(setting,input,"text") as Promise<string>;
}

export async function translateTextWithDetection(setting:TranslationProviderSetting,input:{text:string;targetLanguage:string;sourceLanguage?:string}):Promise<{translatedText:string;sourceLanguage:string}>{
  return requestTranslation(setting,input,"detected") as Promise<{translatedText:string;sourceLanguage:string}>;
}

export async function translateProductNames(setting:TranslationProviderSetting,input:{names:string[];targetLanguage:string}):Promise<string[]>{
  const response=await fetch(`${trimSlash(setting.baseUrl)}/chat/completions`,{
    method:"POST",
    headers:{authorization:`Bearer ${setting.apiKey}`,"content-type":"application/json"},
    body:JSON.stringify({
      model:setting.model,
      messages:[
        {role:"system",content:"You translate ecommerce product titles into the requested target language. Translate descriptive words, but preserve brand names, model identifiers, SKUs, quantities, and symbols. Return only a valid JSON array of translated strings in exactly the same order and with exactly the same number of items. Do not use a markdown fence or add explanations."},
        {role:"user",content:`Target language (BCP 47): ${input.targetLanguage}\n\nProduct titles as JSON:\n${JSON.stringify(input.names)}`},
      ],
    }),
    signal:AbortSignal.timeout(45_000),
  });
  if(!response.ok)throw new Error(`translation_provider_http_${response.status}:${(await response.text()).slice(0,300)}`);
  const body=await response.json() as {choices?:Array<{message?:{content?:string|Array<{type?:string;text?:string}>}}>};
  const content=body.choices?.[0]?.message?.content,translated=typeof content==="string"?content:content?.map(item=>item.text??"").join("");
  if(!translated?.trim())throw new Error("translation_provider_empty_response");
  try{
    const names=JSON.parse(translated.trim()) as unknown;
    if(!Array.isArray(names)||names.length!==input.names.length||names.some(name=>typeof name!=="string"||!name.trim()||name.trim().length>120))throw new Error("invalid");
    return names.map(name=>(name as string).trim());
  }catch{throw new Error("translation_provider_invalid_product_names_response");}
}

async function requestTranslation(setting:TranslationProviderSetting,input:{text:string;targetLanguage:string;sourceLanguage?:string},mode:"text"):Promise<string>;
async function requestTranslation(setting:TranslationProviderSetting,input:{text:string;targetLanguage:string;sourceLanguage?:string},mode:"detected"):Promise<{translatedText:string;sourceLanguage:string}>;
async function requestTranslation(setting:TranslationProviderSetting,input:{text:string;targetLanguage:string;sourceLanguage?:string},mode:"text"|"detected"):Promise<string|{translatedText:string;sourceLanguage:string}>{
  const detected=mode==="detected",sourceLanguage=input.sourceLanguage?normalizeLanguageTag(input.sourceLanguage):undefined;
  const response=await fetch(`${trimSlash(setting.baseUrl)}/chat/completions`,{
    method:"POST",
    headers:{authorization:`Bearer ${setting.apiKey}`,"content-type":"application/json"},
    body:JSON.stringify({
      model:setting.model,
      messages:[
        {role:"system",content:detected
          ?sourceLanguage
            ?"You are a precise business-message translator. The source language is explicitly supplied by the user; do not auto-detect or substitute another language. Translate only into the requested target language. Preserve names, phone numbers, URLs, emoji, line breaks, and formatting. Return only a JSON object with exactly these string fields: translatedText and sourceLanguage. Set sourceLanguage to the supplied BCP 47 source language exactly. Do not use a markdown fence."
            :"You are a precise business-message translator and language detector. Detect the source language and translate only into the requested target language. Preserve names, phone numbers, URLs, emoji, line breaks, and formatting. Return only a JSON object with exactly these string fields: translatedText and sourceLanguage. sourceLanguage must be the most appropriate BCP 47 language tag (for example es, pt-BR, or zh-CN). Do not use a markdown fence."
          :"You are a precise business-message translator. Translate only into the requested target language. Preserve names, phone numbers, URLs, emoji, line breaks, and formatting. Return only the translated text with no explanation, label, markdown fence, or quotation marks."},
        {role:"user",content:`${sourceLanguage?`Source language (BCP 47): ${sourceLanguage}\n`:""}Target language (BCP 47): ${input.targetLanguage}\n\nText to translate:\n${input.text}`},
      ],
    }),
    signal:AbortSignal.timeout(45_000),
  });
  if(!response.ok)throw new Error(`translation_provider_http_${response.status}:${(await response.text()).slice(0,300)}`);
  const body=await response.json() as {choices?:Array<{message?:{content?:string|Array<{type?:string;text?:string}>}}>};
  const content=body.choices?.[0]?.message?.content;
  const translated=typeof content==="string"?content:content?.map(item=>item.text??"").join("");
  if(!translated?.trim())throw new Error("translation_provider_empty_response");
  if(detected){
    try{
      const parsed=JSON.parse(translated.trim()) as {translatedText?:unknown;sourceLanguage?:unknown};
      if(typeof parsed.translatedText!=="string"||!parsed.translatedText.trim()||typeof parsed.sourceLanguage!=="string"||!parsed.sourceLanguage.trim())throw new Error("invalid");
      return{translatedText:parsed.translatedText.trim(),sourceLanguage:sourceLanguage??normalizeLanguageTag(parsed.sourceLanguage)};
    }catch{throw new Error("translation_provider_invalid_detection_response");}
  }
  return translated.trim();
}

export async function transcribeAudio(setting:TranslationProviderSetting,input:{bytes:Buffer;fileName:string;mimeType:string;sourceLanguage?:string}):Promise<string>{
  const diarized=isDiarizationModel(setting.transcriptionModel);
  const request=async(format:"json"|"diarized_json",includeChunking:boolean)=>{
    const form=new FormData();form.append("model",setting.transcriptionModel);form.append("response_format",format);
    const speechLanguage=input.sourceLanguage?.split("-")[0].toLowerCase();
    if(speechLanguage&&/^[a-z]{2}$/.test(speechLanguage))form.append("language",speechLanguage);
    if(includeChunking)form.append("chunking_strategy","auto");
    form.append("file",new Blob([input.bytes],{type:input.mimeType}),input.fileName);
    return fetch(`${trimSlash(setting.baseUrl)}/audio/transcriptions`,{method:"POST",headers:{authorization:`Bearer ${setting.apiKey}`},body:form,signal:AbortSignal.timeout(90_000)});
  };
  let response=await request(diarized?"diarized_json":"json",diarized);
  if(!response.ok&&diarized&&response.status===400)response=await request("json",false);
  if(!response.ok)throw new Error(`transcription_provider_http_${response.status}:${(await response.text()).slice(0,300)}`);
  const raw=await response.text();
  const transcript=extractTranscript(raw,diarized);
  if(!transcript?.trim())throw new Error("transcription_provider_empty_response");
  return transcript.trim();
}

function trimSlash(value:string){return value.replace(/\/+$/,"");}
function isDiarizationModel(model:string){return /(?:^|[-_])diari[sz]e(?:$|[-_])/i.test(model.trim());}
function diarizedTranscript(segments:unknown):string|undefined{
  if(!Array.isArray(segments))return undefined;
  const text=segments.map(segment=>typeof segment==="object"&&segment!==null&&typeof (segment as {text?:unknown}).text==="string"?(segment as {text:string}).text.trim():"").filter(Boolean).join(" ");
  return text||undefined;
}
function extractTranscript(raw:string,diarized:boolean):string|undefined{
  const value=raw.trim();
  if(!value)return undefined;
  try{
    const body=JSON.parse(value) as {text?:unknown;output_text?:unknown;transcript?:unknown;segments?:unknown;data?:unknown;result?:unknown};
    const direct=[body.text,body.output_text,body.transcript,
      typeof body.data==="object"&&body.data!==null?(body.data as {text?:unknown}).text:undefined,
      typeof body.result==="object"&&body.result!==null?(body.result as {text?:unknown}).text:undefined]
      .find(item=>typeof item==="string"&&item.trim());
    if(typeof direct==="string")return direct;
    const segmented=diarizedTranscript(body.segments);
    if(segmented)return segmented;
    return typeof body.data==="string"?body.data:typeof body.result==="string"?body.result:undefined;
  }catch{
    // Some OpenAI-compatible gateways return the transcript as plain text.
    return value;
  }
}
function normalizeLanguageTag(value:string){
  const tag=value.trim().replace(/_/g,"-");
  if(!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag))throw new Error("translation_provider_invalid_source_language");
  const [language,...parts]=tag.split("-");
  return[language.toLowerCase(),...parts.map(part=>part.length===2?part.toUpperCase():part.length===4?`${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`:part)].join("-");
}
