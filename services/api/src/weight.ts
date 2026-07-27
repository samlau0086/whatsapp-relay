export const WEIGHT_UNITS=["g","kg","lbs","oz"] as const;
export type WeightUnit=typeof WEIGHT_UNITS[number];

const GRAMS_PER_UNIT:Record<WeightUnit,number>={
  g:1,
  kg:1000,
  lbs:453.59237,
  oz:28.349523125,
};

export function convertWeight(amount:number,from:WeightUnit,to:WeightUnit):number{
  return amount*GRAMS_PER_UNIT[from]/GRAMS_PER_UNIT[to];
}

export function calculateOrderWeight(
  items:Array<{quantity:number;weightAmount?:number|null;weightUnit?:WeightUnit|null}>,
  targetUnit:WeightUnit,
):number{
  return items.reduce((total,item)=>total+(item.weightAmount&&item.weightUnit
    ? item.quantity*convertWeight(item.weightAmount,item.weightUnit,targetUnit)
    : 0),0);
}
