export const DEFAULT_PAYPAL_REFERENCE_TEMPLATE="Order #{{orderNumber}}";
export const DEFAULT_PAYPAL_NOTE_TEMPLATE="{{orderNotes}}";
export const DEFAULT_PAYPAL_ITEM_NAME_TEMPLATE="{{productName}}";

export const PAYPAL_GLOBAL_TEMPLATE_VARIABLES=["orderNumber","currentDate","recipientName","address","phone","orderNotes","orderTotal","currency","customerName","customerPhone","productNames","productQuantity"] as const;
export const PAYPAL_ITEM_TEMPLATE_VARIABLES=[...PAYPAL_GLOBAL_TEMPLATE_VARIABLES,"productName","unitAmount","lineTotal"] as const;

export type PayPalTemplateContext={
  orderNumber:string;currentDate:string;recipientName:string;address:string;phone:string;orderNotes:string;
  orderTotal:string;currency:string;customerName:string;customerPhone:string;productNames:string;productQuantity:string;
};
export type PayPalItemTemplateContext=PayPalTemplateContext&{productName:string;unitAmount:string;lineTotal:string};

export function validatePayPalTemplate(template:string,scope:"global"|"item"):string|null{
  const allowed:Set<string>=new Set(scope==="item"?PAYPAL_ITEM_TEMPLATE_VARIABLES:PAYPAL_GLOBAL_TEMPLATE_VARIABLES);
  const variables=template.match(/{{\s*[^{}]+\s*}}/g)??[];
  for(const variable of variables){const name=variable.slice(2,-2).trim();if(!allowed.has(name))return `不支持的变量：{{${name}}}`;}
  if(/{{|}}/.test(template.replace(/{{\s*[^{}]+\s*}}/g,"")))return"变量格式无效，请使用 {{variable}}";
  return null;
}

export function renderPayPalTemplate(template:string,context:PayPalTemplateContext|PayPalItemTemplateContext):string{
  return template.replace(/{{\s*([A-Za-z]+)\s*}}/g,(_,name:string)=>String((context as unknown as Record<string,string>)[name]??"")).trim();
}
