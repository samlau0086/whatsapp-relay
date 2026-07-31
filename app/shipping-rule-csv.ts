import { parseCsv } from "./csv-transfer";
import type { WeightUnit } from "./weight";

export const SHIPPING_RULE_CSV_HEADERS=[
  "destination_country_code",
  "destination_province",
  "shipping_class",
  "calculation_mode",
  "first_item_price",
  "additional_item_price",
  "first_weight",
  "additional_weight",
  "weight_unit",
  "first_weight_price",
  "additional_weight_price",
] as const;

export type ShippingRuleCsvClass={id:string;name:string};
export type ShippingRuleCsvRule={
  shippingClassId:string;
  destinationCountryCode:string;
  destinationProvince:string;
  mode:"quantity"|"weight";
  firstItemPrice:string;
  additionalItemPrice:string;
  firstWeight:string;
  additionalWeight:string;
  weightUnit:WeightUnit;
  firstWeightPrice:string;
  additionalWeightPrice:string;
};
export type ShippingRuleCsvPreview={
  line:number;
  values:Record<(typeof SHIPPING_RULE_CSV_HEADERS)[number],string>;
  rule:ShippingRuleCsvRule|null;
  error:string;
};

const HEADER_ALIASES:Record<string,(typeof SHIPPING_RULE_CSV_HEADERS)[number]>={
  destination_country_code:"destination_country_code",country_code:"destination_country_code","国家代码":"destination_country_code",
  destination_province:"destination_province",province:"destination_province",state:"destination_province","省份":"destination_province","省份/州":"destination_province",
  shipping_class:"shipping_class","shipping class":"shipping_class","运费类别":"shipping_class",
  calculation_mode:"calculation_mode",mode:"calculation_mode","计费模式":"calculation_mode",
  first_item_price:"first_item_price","首件价格":"first_item_price",
  additional_item_price:"additional_item_price","续件价格":"additional_item_price",
  first_weight:"first_weight","首重":"first_weight",
  additional_weight:"additional_weight","续重":"additional_weight",
  weight_unit:"weight_unit","重量单位":"weight_unit",
  first_weight_price:"first_weight_price","首重价格":"first_weight_price",
  additional_weight_price:"additional_weight_price","续重价格":"additional_weight_price",
};
const MONEY=/^\d+(?:\.\d{1,2})?$/;
const POSITIVE=/^(?:\d+(?:\.\d+)?|\.\d+)$/;
const WEIGHT_UNITS=new Set<WeightUnit>(["g","kg","lbs","oz"]);

function emptyValues():Record<(typeof SHIPPING_RULE_CSV_HEADERS)[number],string>{
  return Object.fromEntries(SHIPPING_RULE_CSV_HEADERS.map(header=>[header,""])) as Record<(typeof SHIPPING_RULE_CSV_HEADERS)[number],string>;
}

function normalizedMode(value:string):"quantity"|"weight"|null{
  const mode=value.trim().toLocaleLowerCase();
  if(mode==="quantity"||mode==="按数量")return"quantity";
  if(mode==="weight"||mode==="按重量")return"weight";
  return null;
}

export function shippingRuleCsvKey(rule:Pick<ShippingRuleCsvRule,"shippingClassId"|"destinationCountryCode"|"destinationProvince">){
  return`${rule.shippingClassId}|${rule.destinationCountryCode.toUpperCase()}|${rule.destinationProvince.trim().toLocaleLowerCase()}`;
}

export function parseShippingRuleCsv(text:string,classes:ShippingRuleCsvClass[]){
  const data=parseCsv(text);
  if(!data.length)return{rows:[] as ShippingRuleCsvPreview[],rules:[] as ShippingRuleCsvRule[],fatal:"CSV 文件为空"};
  if(data.length>502)return{rows:[] as ShippingRuleCsvPreview[],rules:[] as ShippingRuleCsvRule[],fatal:"每次最多导入 500 条规则"};
  const headers=data[0].map(value=>HEADER_ALIASES[value.trim().toLocaleLowerCase()]??null);
  const missing=SHIPPING_RULE_CSV_HEADERS.filter(header=>!headers.includes(header));
  if(missing.length)return{rows:[] as ShippingRuleCsvPreview[],rules:[] as ShippingRuleCsvRule[],fatal:`缺少列：${missing.join("、")}`};
  const classMap=new Map(classes.flatMap(item=>[[item.name.trim().toLocaleLowerCase(),item.id],[item.id.toLocaleLowerCase(),item.id]]));
  const seen=new Set<string>(),rules:ShippingRuleCsvRule[]=[];
  const rows=data.slice(1).map((cells,index)=>{
    const values=emptyValues();
    headers.forEach((header,column)=>{if(header)values[header]=String(cells[column]??"").trim();});
    const line=index+2,country=values.destination_country_code.toUpperCase(),province=values.destination_province,mode=normalizedMode(values.calculation_mode),className=values.shipping_class,classId=className?classMap.get(className.toLocaleLowerCase())??"":"";let error="";
    if(country&&!/^[A-Z]{2}$/.test(country))error="国家代码必须是两位字母";
    else if(province&&!country)error="填写省份/州时国家代码必填";
    else if(className&&!classId)error=`Shipping class 不存在：${className}`;
    else if(!mode)error="计费模式仅支持 quantity 或 weight";
    const rule:ShippingRuleCsvRule|null=mode?{
      shippingClassId:classId,
      destinationCountryCode:country,
      destinationProvince:province,
      mode,
      firstItemPrice:values.first_item_price,
      additionalItemPrice:values.additional_item_price,
      firstWeight:values.first_weight,
      additionalWeight:values.additional_weight,
      weightUnit:(values.weight_unit||"kg").toLocaleLowerCase() as WeightUnit,
      firstWeightPrice:values.first_weight_price,
      additionalWeightPrice:values.additional_weight_price,
    }:null;
    if(!error&&rule){
      if(mode==="quantity"){
        if(!MONEY.test(rule.firstItemPrice)||!MONEY.test(rule.additionalItemPrice))error="数量规则需填写非负且最多两位小数的首件/续件价格";
        else if([values.first_weight,values.additional_weight,values.weight_unit,values.first_weight_price,values.additional_weight_price].some(Boolean))error="数量规则不能填写重量字段";
      }else{
        if(!POSITIVE.test(rule.firstWeight)||Number(rule.firstWeight)<=0||!POSITIVE.test(rule.additionalWeight)||Number(rule.additionalWeight)<=0)error="首重和续重必须大于 0";
        else if(!WEIGHT_UNITS.has(rule.weightUnit))error="重量单位仅支持 g、kg、lbs、oz";
        else if(!MONEY.test(rule.firstWeightPrice)||!MONEY.test(rule.additionalWeightPrice))error="重量规则需填写非负且最多两位小数的首重/续重价格";
        else if([values.first_item_price,values.additional_item_price].some(Boolean))error="重量规则不能填写数量价格字段";
      }
      const key=shippingRuleCsvKey(rule);
      if(!error&&seen.has(key))error="CSV 中地区与 shipping class 重复";
      if(!error){seen.add(key);rules.push(rule);}
    }
    return{line,values,rule,error};
  });
  return{rows,rules,fatal:rows.length?"":"CSV 中没有规则"};
}

export function shippingRuleCsvRows(rules:ShippingRuleCsvRule[],classes:ShippingRuleCsvClass[]):unknown[][]{
  const names=new Map(classes.map(item=>[item.id,item.name]));
  return rules.map(rule=>[
    rule.destinationCountryCode,
    rule.destinationProvince,
    rule.shippingClassId?names.get(rule.shippingClassId)??rule.shippingClassId:"",
    rule.mode,
    rule.mode==="quantity"?rule.firstItemPrice:"",
    rule.mode==="quantity"?rule.additionalItemPrice:"",
    rule.mode==="weight"?rule.firstWeight:"",
    rule.mode==="weight"?rule.additionalWeight:"",
    rule.mode==="weight"?rule.weightUnit:"",
    rule.mode==="weight"?rule.firstWeightPrice:"",
    rule.mode==="weight"?rule.additionalWeightPrice:"",
  ]);
}

export function validateShippingRuleCsvImport(mode:"replace"|"append",rules:ShippingRuleCsvRule[],currentRules:ShippingRuleCsvRule[]){
  const globalDefaults=rules.filter(rule=>!rule.shippingClassId&&!rule.destinationCountryCode&&!rule.destinationProvince).length;
  if(mode==="replace"&&rules.length>0&&globalDefaults!==1)return"覆盖导入必须包含且只能包含一条全球默认规则";
  if(mode==="append"&&globalDefaults>0)return"追加导入不能包含全球默认规则";
  if(mode==="append"){
    const existing=new Set(currentRules.map(shippingRuleCsvKey));
    if(rules.some(rule=>existing.has(shippingRuleCsvKey(rule))))return"追加规则与当前模板已有规则重复";
  }
  if((mode==="append"?currentRules.length+rules.length:rules.length)>101)return"模板最多支持 101 条规则";
  return"";
}
