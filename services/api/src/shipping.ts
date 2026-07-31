import { convertWeight, type WeightUnit } from "./weight.js";

export type QuantityShippingRule={
  mode:"quantity";
  firstItemPrice:number;
  additionalItemPrice:number;
};

export type WeightShippingRule={
  mode:"weight";
  firstWeight:number;
  additionalWeight:number;
  weightUnit:WeightUnit;
  firstWeightPrice:number;
  additionalWeightPrice:number;
};

export type ShippingRule=QuantityShippingRule|WeightShippingRule;

export type ShippingQuoteItem={
  name:string;
  quantity:number;
  weightAmount?:number|null;
  weightUnit?:WeightUnit|null;
  shippingClassId?:string|null;
  shippingClassName?:string|null;
};

export type ShippingRuleEntry={
  shippingClassId:string|null;
  shippingClassName:string|null;
  destinationCountryCode:string|null;
  destinationProvince:string|null;
  rule:ShippingRule;
};

export type ShippingDestination={
  countryCode?:string|null;
  province?:string|null;
};

export type ShippingQuoteBreakdown={
  shippingClassId:string|null;
  shippingClassName:string;
  mode:ShippingRule["mode"];
  quantity:number;
  weightAmount:number|null;
  weightUnit:WeightUnit|null;
  amount:number;
  matchedCountryCode:string|null;
  matchedProvince:string|null;
};

export type ShippingCalculation=
  |{ok:true;amount:number;breakdown:ShippingQuoteBreakdown[]}
  |{ok:false;missingWeightItems:Array<{index:number;name:string}>};

const money=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;

export function calculateShipping(
  items:ShippingQuoteItem[],
  defaultRule:ShippingRule,
  overrides:ShippingRuleEntry[],
  destination:ShippingDestination={},
):ShippingCalculation{
  const countryCode=destination.countryCode?.trim().toUpperCase()||null,province=destination.province?.trim().toLocaleLowerCase()||null;
  const matchingRule=(shippingClassId:string|null)=>{
    const zones:Array<{countryCode:string|null;province:string|null}>=[];
    if(countryCode&&province)zones.push({countryCode,province});
    if(countryCode)zones.push({countryCode,province:null});
    zones.push({countryCode:null,province:null});
    for(const zone of zones){
      const classRule=shippingClassId?overrides.find(entry=>entry.shippingClassId===shippingClassId&&entry.destinationCountryCode===zone.countryCode&&(entry.destinationProvince?.trim().toLocaleLowerCase()??null)===zone.province):undefined;
      if(classRule)return classRule;
      const zoneDefault=overrides.find(entry=>entry.shippingClassId===null&&entry.destinationCountryCode===zone.countryCode&&(entry.destinationProvince?.trim().toLocaleLowerCase()??null)===zone.province);
      if(zoneDefault)return zoneDefault;
    }
    return{shippingClassId:null,shippingClassName:null,destinationCountryCode:null,destinationProvince:null,rule:defaultRule};
  };
  const groups=new Map<string,{shippingClassId:string|null;shippingClassName:string;items:Array<ShippingQuoteItem&{index:number}>}>();
  items.forEach((item,index)=>{
    const key=item.shippingClassId??"__default__";
    const group=groups.get(key)??{shippingClassId:item.shippingClassId??null,shippingClassName:item.shippingClassName?.trim()||"默认",items:[]};
    group.items.push({...item,index});
    groups.set(key,group);
  });
  const missingWeightItems:Array<{index:number;name:string}>=[],breakdown:ShippingQuoteBreakdown[]=[];
  for(const group of groups.values()){
    const entry=matchingRule(group.shippingClassId),rule=entry.rule;
    const quantity=group.items.reduce((sum,item)=>sum+item.quantity,0);
    if(rule.mode==="quantity"){
      breakdown.push({shippingClassId:group.shippingClassId,shippingClassName:group.shippingClassName,mode:"quantity",quantity,weightAmount:null,weightUnit:null,amount:money(rule.firstItemPrice+Math.max(0,quantity-1)*rule.additionalItemPrice),matchedCountryCode:entry.destinationCountryCode,matchedProvince:entry.destinationProvince});
      continue;
    }
    let weight=0;
    for(const item of group.items){
      if(item.weightAmount===null||item.weightAmount===undefined||!item.weightUnit){
        missingWeightItems.push({index:item.index,name:item.name});
      }else weight+=item.quantity*convertWeight(item.weightAmount,item.weightUnit,rule.weightUnit);
    }
    if(missingWeightItems.length)continue;
    const steps=Math.max(0,Math.ceil((weight-rule.firstWeight)/rule.additionalWeight));
    breakdown.push({shippingClassId:group.shippingClassId,shippingClassName:group.shippingClassName,mode:"weight",quantity,weightAmount:weight,weightUnit:rule.weightUnit,amount:money(rule.firstWeightPrice+steps*rule.additionalWeightPrice),matchedCountryCode:entry.destinationCountryCode,matchedProvince:entry.destinationProvince});
  }
  if(missingWeightItems.length)return{ok:false,missingWeightItems};
  return{ok:true,amount:money(breakdown.reduce((sum,item)=>sum+item.amount,0)),breakdown};
}

export function convertShippingCurrency(amount:number,fromRate:number,toRate:number):number{
  if(!Number.isFinite(fromRate)||!Number.isFinite(toRate)||fromRate<=0||toRate<=0)throw new Error("invalid_currency_rate");
  return money(amount/fromRate*toRate);
}
