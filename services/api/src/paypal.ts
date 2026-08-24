export type PayPalEnvironment="sandbox"|"live";
export type PayPalInvoiceItem={name:string;quantity:number;unitAmount:number};
export type PayPalInvoiceInput={requestId:string;reference:string;currency:string;note?:string;items:PayPalInvoiceItem[]};
export type PayPalInvoiceResult={invoiceId:string;status:string;paymentUrl:string|null};
export type PayPalInvoiceDetail=PayPalInvoiceResult&{transactionId:string|null};

export class PayPalApiError extends Error{
  constructor(public readonly status:number,public readonly code:string,message:string){super(message);this.name="PayPalApiError";}
}

export function paypalBaseUrl(environment:PayPalEnvironment):string{return environment==="live"?"https://api-m.paypal.com":"https://api-m.sandbox.paypal.com";}

export function buildPayPalInvoice(input:PayPalInvoiceInput):Record<string,unknown>{
  return{
    detail:{reference:input.reference,invoice_date:new Date().toISOString().slice(0,10),currency_code:input.currency,note:input.note||undefined,payment_term:{term_type:"DUE_ON_RECEIPT"}},
    items:input.items.map(item=>({name:item.name,quantity:String(item.quantity),unit_amount:{currency_code:input.currency,value:item.unitAmount.toFixed(2)},unit_of_measure:"QUANTITY"})),
    configuration:{partial_payment:{allow_partial_payment:false},allow_tip:false},
  };
}

type TokenEntry={value:string;expiresAt:number};
const tokenCache=new Map<string,TokenEntry>();

export class PayPalClient{
  constructor(private readonly setting:{environment:PayPalEnvironment;clientId:string;clientSecret:string},private readonly request:typeof fetch=fetch){}

  private async accessToken():Promise<string>{
    const key=`${this.setting.environment}:${this.setting.clientId}`,cached=tokenCache.get(key);
    if(cached&&cached.expiresAt>Date.now()+30_000)return cached.value;
    const response=await this.request(`${paypalBaseUrl(this.setting.environment)}/v1/oauth2/token`,{method:"POST",headers:{authorization:`Basic ${Buffer.from(`${this.setting.clientId}:${this.setting.clientSecret}`).toString("base64")}`,"content-type":"application/x-www-form-urlencoded",accept:"application/json"},body:"grant_type=client_credentials"});
    const body=await response.json().catch(()=>({})) as Record<string,unknown>;
    if(!response.ok||typeof body.access_token!=="string")throw paypalError(response.status,body,"PayPal credential verification failed");
    const entry={value:body.access_token,expiresAt:Date.now()+Math.max(60,Number(body.expires_in??300))*1000};tokenCache.set(key,entry);return entry.value;
  }

  private async api(path:string,init:RequestInit={}):Promise<Record<string,unknown>>{
    const token=await this.accessToken();const response=await this.request(`${paypalBaseUrl(this.setting.environment)}${path}`,{...init,headers:{authorization:`Bearer ${token}`,accept:"application/json","content-type":"application/json",...(init.headers??{})}});
    const text=response.status===204?"":await response.text();let body:Record<string,unknown>={};
    if(text){try{const parsed=JSON.parse(text);if(parsed&&typeof parsed==="object"&&!Array.isArray(parsed))body=parsed as Record<string,unknown>;}catch{body={message:text.replace(/\s+/g," ").slice(0,500)};}}
    if(!response.ok)throw paypalError(response.status,body,"PayPal request failed");return body;
  }

  async verify():Promise<void>{await this.accessToken();}

  async createPayableInvoice(input:PayPalInvoiceInput):Promise<PayPalInvoiceResult>{
    const created=await this.api("/v2/invoicing/invoices",{method:"POST",headers:{"PayPal-Request-Id":input.requestId,Prefer:"return=representation"},body:JSON.stringify(buildPayPalInvoice(input))});
    const invoiceId=String(created.id??"");if(!invoiceId)throw new PayPalApiError(502,"missing_invoice_id","PayPal did not return an invoice ID");
    const sent=await this.api(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`,{method:"POST",headers:{"PayPal-Request-Id":`${input.requestId}-send`},body:JSON.stringify({send_to_invoicer:false,send_to_recipient:false})});
    let paymentUrl=findPaymentUrl(sent);let status=String(sent.status??"SHARED");
    if(!paymentUrl){const detail=await this.getInvoice(invoiceId);paymentUrl=detail.paymentUrl;status=detail.status;}
    if(!paymentUrl)throw new PayPalApiError(502,"missing_payer_view","PayPal did not return a payer-view link");
    return{invoiceId,status,paymentUrl};
  }

  async getInvoice(invoiceId:string):Promise<PayPalInvoiceDetail>{const encoded=encodeURIComponent(invoiceId),body=await this.api(`/v2/invoicing/invoices/${encoded}`);let transactionId=findTransactionId(body);if(!transactionId&&String(body.status??"").toUpperCase()==="PAID"){const payments=await this.api(`/v2/invoicing/invoices/${encoded}/payments`);transactionId=findTransactionId(payments);}return{invoiceId:String(body.id??invoiceId),status:String(body.status??"UNKNOWN"),paymentUrl:findPaymentUrl(body),transactionId};}

  async addTracking(input:{transactionId:string;carrier:string;trackingNumber:string}):Promise<void>{
    await this.api("/v1/shipping/trackers",{method:"POST",body:JSON.stringify({transaction_id:input.transactionId,carrier:input.carrier.trim().toUpperCase().replace(/[\s-]+/g,"_"),tracking_number:input.trackingNumber,shipment_status:"SHIPPED",notify_payer:false})});
  }

  async cancelInvoice(invoiceId:string,status:string):Promise<void>{
    if(status.toUpperCase()==="DRAFT"){await this.api(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`,{method:"DELETE"});return;}
    await this.api(`/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`,{method:"POST",body:JSON.stringify({send_to_invoicer:false,send_to_recipient:false})});
  }
}

function findLink(body:Record<string,unknown>,rel:string):string|null{const links=Array.isArray(body.links)?body.links:[];const found=links.find(link=>link&&typeof link==="object"&&(link as Record<string,unknown>).rel===rel) as Record<string,unknown>|undefined;return typeof found?.href==="string"?found.href:null;}

function findPaymentUrl(body:Record<string,unknown>):string|null{
  if(body.rel==="payer-view"&&typeof body.href==="string")return body.href;
  const linked=findLink(body,"payer-view");if(linked)return linked;
  const detail=body.detail&&typeof body.detail==="object"?body.detail as Record<string,unknown>:null,metadata=detail?.metadata&&typeof detail.metadata==="object"?detail.metadata as Record<string,unknown>:null;
  return typeof metadata?.recipient_view_url==="string"?metadata.recipient_view_url:null;
}

function findTransactionId(body:Record<string,unknown>):string|null{
  const payments=Array.isArray(body.payments)?body.payments:[];
  for(const payment of payments){if(payment&&typeof payment==="object"){const item=payment as Record<string,unknown>,transactionId=item.transaction_id??item.transactionId;if(typeof transactionId==="string"&&transactionId)return transactionId;}}
  return null;
}

function paypalError(status:number,body:Record<string,unknown>,fallback:string):PayPalApiError{const details=Array.isArray(body.details)?body.details:[],first=details[0]&&typeof details[0]==="object"?details[0] as Record<string,unknown>:null;return new PayPalApiError(status,String(body.name??body.error??"paypal_error"),String(first?.description??body.message??body.error_description??fallback));}

export function clearPayPalTokenCache():void{tokenCache.clear();}
