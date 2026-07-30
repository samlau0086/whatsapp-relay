export const QUICK_REPLY_VARIABLES=[
  "first_name",
  "middle_name",
  "last_name",
  "shipping_address",
  "email",
  "mobile",
  "whatsapp",
] as const;

export type QuickReplyVariable=typeof QUICK_REPLY_VARIABLES[number];
export type QuickReplyVariableValues=Record<QuickReplyVariable,string>;

const VARIABLE_PATTERN=/{{\s*([a-z][a-z0-9 _-]*)\s*}}/gi;
const supported=new Set<string>(QUICK_REPLY_VARIABLES);

export function normalizeQuickReplyVariable(value:string):string{
  return value.trim().toLowerCase().replace(/[\s-]+/g,"_");
}

export function quickReplyVariableNames(template:string):string[]{
  return Array.from(template.matchAll(VARIABLE_PATTERN),match=>normalizeQuickReplyVariable(match[1]));
}

export function renderQuickReplyVariables(template:string,values:QuickReplyVariableValues):{text:string;missing:QuickReplyVariable[];unsupported:string[]}{
  const missing=new Set<QuickReplyVariable>(),unsupported=new Set<string>();
  const text=template.replace(VARIABLE_PATTERN,(source:string,rawName:string)=>{
    const name=normalizeQuickReplyVariable(rawName);
    if(!supported.has(name)){unsupported.add(name);return source;}
    const variable=name as QuickReplyVariable,value=values[variable].trim();
    if(!value){missing.add(variable);return source;}
    return value;
  });
  return{text,missing:[...missing],unsupported:[...unsupported]};
}
