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

export function formatWeight(amount:number,unit:WeightUnit):string{
  const digits=amount>=100?2:amount>=1?3:4;
  return `${Number(amount.toFixed(digits))} ${unit}`;
}
