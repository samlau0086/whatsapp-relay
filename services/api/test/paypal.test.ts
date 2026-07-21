import assert from "node:assert/strict";
import test from "node:test";
import { PayPalApiError, PayPalClient, buildPayPalInvoice, clearPayPalTokenCache, paypalBaseUrl } from "../src/paypal.js";

test("selects the official PayPal API host for each environment",()=>{
  assert.equal(paypalBaseUrl("sandbox"),"https://api-m.sandbox.paypal.com");
  assert.equal(paypalBaseUrl("live"),"https://api-m.paypal.com");
});

test("maps order products and fees into invoice line items",()=>{
  const invoice=buildPayPalInvoice({requestId:"request-1",orderNumber:"20260721-001",currency:"USD",description:"Handle with care",items:[{name:"Product",quantity:2,unitAmount:12.5},{name:"Shipping",quantity:1,unitAmount:4}]});
  assert.deepEqual(invoice.items,[{name:"Product",quantity:"2",unit_amount:{currency_code:"USD",value:"12.50"},unit_of_measure:"QUANTITY"},{name:"Shipping",quantity:"1",unit_amount:{currency_code:"USD",value:"4.00"},unit_of_measure:"QUANTITY"}]);
  assert.equal((invoice.detail as Record<string,unknown>).reference,"Order #20260721-001");
  assert.deepEqual(invoice.configuration,{partial_payment:{allow_partial_payment:false},allow_tip:false});
});

test("creates and shares an invoice while reusing the OAuth token",async()=>{
  clearPayPalTokenCache();const calls:Array<{url:string;init?:RequestInit}>=[];
  const request=async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input);calls.push({url,init});if(url.endsWith("/v1/oauth2/token"))return new Response(JSON.stringify({access_token:"token",expires_in:3600}),{status:200,headers:{"content-type":"application/json"}});if(url.endsWith("/v2/invoicing/invoices"))return new Response(JSON.stringify({id:"INV2-123",status:"DRAFT"}),{status:201,headers:{"content-type":"application/json"}});if(url.endsWith("/send"))return new Response(JSON.stringify({rel:"payer-view",href:"https://www.sandbox.paypal.com/invoice/p/#INV2-123"}),{status:202,headers:{"content-type":"application/json"}});throw new Error(`unexpected ${url}`);};
  const client=new PayPalClient({environment:"sandbox",clientId:"client",clientSecret:"secret"},request as typeof fetch),input={requestId:"8b6490ee-bc39-4180-a1c5-9eea37fe7a1a",orderNumber:"001",currency:"USD",items:[{name:"Item",quantity:1,unitAmount:10}]};
  const first=await client.createPayableInvoice(input),second=await client.createPayableInvoice({...input,requestId:"23bdbdc2-beb8-4141-8f8f-09a2132ecfc8"});
  assert.equal(first.paymentUrl,"https://www.sandbox.paypal.com/invoice/p/#INV2-123");assert.equal(second.status,"SHARED");assert.equal(calls.filter(call=>call.url.endsWith("/v1/oauth2/token")).length,1);assert.equal(new Headers(calls.find(call=>call.url.endsWith("/v1/oauth2/token"))?.init?.headers).get("authorization"),`Basic ${Buffer.from("client:secret").toString("base64")}`);
  const sendCall=calls.find(call=>call.url.endsWith("/send"));assert.deepEqual(JSON.parse(String(sendCall?.init?.body)),{send_to_invoicer:false,send_to_recipient:false});
});

test("reads the recipient view URL from invoice metadata when send omits it",async()=>{
  clearPayPalTokenCache();
  const request=async(input:string|URL|Request)=>{const url=String(input);if(url.endsWith("/v1/oauth2/token"))return Response.json({access_token:"token",expires_in:3600});if(url.endsWith("/v2/invoicing/invoices"))return Response.json({id:"INV2-456",status:"DRAFT"},{status:201});if(url.endsWith("/send"))return Response.json({},{status:202});if(url.endsWith("/INV2-456"))return Response.json({id:"INV2-456",status:"SENT",detail:{metadata:{recipient_view_url:"https://www.sandbox.paypal.com/invoice/p/#INV2-456"}}});throw new Error(`unexpected ${url}`);};
  const result=await new PayPalClient({environment:"sandbox",clientId:"client",clientSecret:"secret"},request as typeof fetch).createPayableInvoice({requestId:"7ad43f69-b89b-49c1-8a73-c2dc8841ca0f",orderNumber:"002",currency:"USD",items:[{name:"Item",quantity:1,unitAmount:10}]});
  assert.equal(result.paymentUrl,"https://www.sandbox.paypal.com/invoice/p/#INV2-456");assert.equal(result.status,"SENT");
});

test("returns a sanitized PayPal API error",async()=>{
  clearPayPalTokenCache();const request=async()=>new Response(JSON.stringify({name:"AUTHENTICATION_FAILURE",message:"Authentication failed"}),{status:401,headers:{"content-type":"application/json"}}),client=new PayPalClient({environment:"live",clientId:"bad",clientSecret:"bad"},request as typeof fetch);
  await assert.rejects(()=>client.verify(),(error:unknown)=>error instanceof PayPalApiError&&error.status===401&&error.code==="AUTHENTICATION_FAILURE");
});
