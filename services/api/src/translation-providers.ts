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
  const response=await fetch(`${trimSlash(setting.baseUrl)}/chat/completions`,{
    method:"POST",
    headers:{authorization:`Bearer ${setting.apiKey}`,"content-type":"application/json"},
    body:JSON.stringify({
      model:setting.model,
      messages:[
        {role:"system",content:"You are a precise business-message translator. Translate only into the requested target language. Preserve names, phone numbers, URLs, emoji, line breaks, and formatting. Return only the translated text with no explanation, label, markdown fence, or quotation marks."},
        {role:"user",content:`Target language (BCP 47): ${input.targetLanguage}\n\nText to translate:\n${input.text}`},
      ],
    }),
    signal:AbortSignal.timeout(45_000),
  });
  if(!response.ok)throw new Error(`translation_provider_http_${response.status}:${(await response.text()).slice(0,300)}`);
  const body=await response.json() as {choices?:Array<{message?:{content?:string|Array<{type?:string;text?:string}>}}>};
  const content=body.choices?.[0]?.message?.content;
  const translated=typeof content==="string"?content:content?.map(item=>item.text??"").join("");
  if(!translated?.trim())throw new Error("translation_provider_empty_response");
  return translated.trim();
}

export async function transcribeAudio(setting:TranslationProviderSetting,input:{bytes:Buffer;fileName:string;mimeType:string}):Promise<string>{
  const form=new FormData();
  form.append("model",setting.transcriptionModel);
  form.append("response_format","json");
  form.append("file",new Blob([input.bytes],{type:input.mimeType}),input.fileName);
  const response=await fetch(`${trimSlash(setting.baseUrl)}/audio/transcriptions`,{
    method:"POST",
    headers:{authorization:`Bearer ${setting.apiKey}`},
    body:form,
    signal:AbortSignal.timeout(90_000),
  });
  if(!response.ok)throw new Error(`transcription_provider_http_${response.status}:${(await response.text()).slice(0,300)}`);
  const body=await response.json() as {text?:string};
  if(!body.text?.trim())throw new Error("transcription_provider_empty_response");
  return body.text.trim();
}

function trimSlash(value:string){return value.replace(/\/+$/,"");}
