export const PAYPAL_FEE_NAME="PayPal 手续费";

// Uses integer arithmetic so decimal floating point cannot undercharge the order.
export function calculatePayPalFee(netAmount:number,ratePercent:number,fixedFee:number):number{
  const netCents=toCents(netAmount),fixedCents=toCents(fixedFee),rateParts=Math.round(ratePercent*10_000);
  if(netCents<0||fixedCents<0||rateParts<0||rateParts>=1_000_000)throw new Error("invalid_paypal_fee_rate");
  if(rateParts===0&&fixedCents===0)return 0;
  const numerator=BigInt(netCents+fixedCents)*1_000_000n,denominator=BigInt(1_000_000-rateParts);
  const grossCents=Number((numerator+denominator-1n)/denominator);
  return (grossCents-netCents)/100;
}

function toCents(value:number):number{
  const cents=Math.round(Number(value)*100);
  if(!Number.isSafeInteger(cents))throw new Error("invalid_money_amount");
  return cents;
}
