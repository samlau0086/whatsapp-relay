import type { PoolClient } from "pg";

export const DEFAULT_ORDER_NUMBER_TEMPLATE="{YYYY}{MM}{DD}-{SEQ:3}";
export const DEFAULT_ORDER_TIMEZONE="Asia/Shanghai";

const TOKEN_PATTERN=/\{(?:YYYY|YY|MM|DD|SEQ:\d+)\}/g;
const UNKNOWN_TOKEN_PATTERN=/\{[^{}]*\}/g;
const EXACT_TOKEN_PATTERN=/^\{(?:YYYY|YY|MM|DD|SEQ:\d+)\}$/;

export type OrderNumberSettings={template:string;timezone:string};

export function isValidTimeZone(value:string):boolean{
  try{new Intl.DateTimeFormat("en-US",{timeZone:value}).format();return true;}catch{return false;}
}

export function validateOrderNumberTemplate(template:string):string|null{
  if(!template||template.length>80)return "模板长度必须在 1 到 80 个字符之间";
  if(/[\r\n\t]/.test(template))return "模板不能包含换行或制表符";
  const tokens=template.match(TOKEN_PATTERN)??[];
  const unknown=template.match(UNKNOWN_TOKEN_PATTERN)?.filter(token=>!EXACT_TOKEN_PATTERN.test(token))??[];
  if(unknown.length)return `不支持的变量：${unknown[0]}`;
  const counts=(name:string)=>tokens.filter(token=>name==="YEAR"?/^\{(?:YYYY|YY)\}$/.test(token):token.startsWith(`{${name}`)).length;
  if(counts("YEAR")!==1||counts("MM")!==1||counts("DD")!==1||counts("SEQ")!==1)return "模板必须且只能包含一个年份、月份、日期和当日序号变量";
  const sequence=tokens.find(token=>token.startsWith("{SEQ:"));
  const width=Number(sequence?.slice(5,-1));
  if(!Number.isInteger(width)||width<1||width>9)return "序号位数必须在 1 到 9 之间";
  if(formatOrderNumber(template,new Date("2099-12-31T12:00:00Z"),"UTC",999_999_999).length>120)return "生成的订单号不能超过 120 个字符";
  return null;
}

export function businessDate(date:Date,timezone:string):string{
  const parts=new Intl.DateTimeFormat("en-CA",{timeZone:timezone,year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const value=(type:string)=>parts.find(part=>part.type===type)?.value??"";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function formatOrderNumber(template:string,date:Date,timezone:string,sequence:number):string{
  const [year,month,day]=businessDate(date,timezone).split("-");
  return template.replace(TOKEN_PATTERN,token=>{
    if(token==="{YYYY}")return year;
    if(token==="{YY}")return year.slice(-2);
    if(token==="{MM}")return month;
    if(token==="{DD}")return day;
    const width=Number(token.slice(5,-1));
    return String(sequence).padStart(width,"0");
  });
}

export function orderNumberPreview(settings:OrderNumberSettings,date=new Date()):string{
  return formatOrderNumber(settings.template,date,settings.timezone,1);
}

export async function allocateOrderNumber(client:PoolClient,now=new Date()):Promise<{displayOrderNumber:string;sequenceDate:string;dailySequence:number;settings:OrderNumberSettings}>{
  const settingResult=await client.query("SELECT number_template,timezone FROM order_settings WHERE singleton=true FOR SHARE");
  const settings:OrderNumberSettings=settingResult.rowCount?{template:String(settingResult.rows[0].number_template),timezone:String(settingResult.rows[0].timezone)}:{template:DEFAULT_ORDER_NUMBER_TEMPLATE,timezone:DEFAULT_ORDER_TIMEZONE};
  const sequenceDate=businessDate(now,settings.timezone);
  const sequenceResult=await client.query("INSERT INTO order_daily_sequences(sequence_date,last_value) VALUES($1,1) ON CONFLICT(sequence_date) DO UPDATE SET last_value=order_daily_sequences.last_value+1 RETURNING last_value",[sequenceDate]);
  const dailySequence=Number(sequenceResult.rows[0].last_value);
  return{displayOrderNumber:formatOrderNumber(settings.template,now,settings.timezone,dailySequence),sequenceDate,dailySequence,settings};
}
