"use client";

import { Download, FileText, UploadCloud, X } from "lucide-react";
import { useRef, useState } from "react";
import { downloadCsv, parseCsv } from "./csv-transfer";

type RequestResult={response:Response;token:string};
type AccountOption={id:string;name:string};
type ImportKind="contacts"|"orders";
type PreviewRow={line:number;values:Record<string,string>;error:string};

const CONFIG={
  contacts:{
    title:"CSV 批量导入联系人",
    description:"按 WhatsApp 账号和号码新增或更新联系人。重复号码会更新资料，不会重复创建。",
    headers:["account","phone","first_name","middle_name","last_name","alias","email","note"],
    example:[["销售主账号","+8613800138000","Alice","","Smith","Alice","alice@example.com","重点客户"]],
  },
  orders:{
    title:"CSV 批量导入订单",
    description:"每行创建一张草稿订单。可填写会话 ID，或用账号与客户号码自动匹配已有会话。",
    headers:["conversation_id","account","customer_phone","currency","business_status","description","items","fees"],
    example:[["","销售主账号","+8613800138000","USD","quotation","首批报价","SKU-001|香水 50ml|2|29.90;SKU-002|礼盒|1|49.90","运费|8.00"]],
  },
} satisfies Record<ImportKind,{title:string;description:string;headers:string[];example:string[][]}>;

const BUSINESS_STATUSES=new Set(["quotation","pending_confirmation","pending_payment","paid","processing","shipped","completed","cancelled"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedPhone(value:string){return value.replace(/[^\d]/g,"");}
function parseHeaders(rows:string[][],expected:string[]){
  const headers=(rows[0]??[]).map(value=>value.trim().toLowerCase());
  const missing=expected.filter(header=>!headers.includes(header));
  return{headers,missing};
}

function previewRows(kind:ImportKind,text:string,accounts:AccountOption[]){
  const rows=parseCsv(text);if(!rows.length)return{rows:[] as PreviewRow[],fatal:"CSV 文件为空"};
  const config=CONFIG[kind],{headers,missing}=parseHeaders(rows,config.headers);
  if(missing.length)return{rows:[] as PreviewRow[],fatal:`缺少列：${missing.join("、")}`};
  if(rows.length>501)return{rows:[] as PreviewRow[],fatal:"每次最多导入 500 行"};
  const accountNames=new Set(accounts.flatMap(account=>[account.id.toLowerCase(),account.name.toLowerCase()]));
  const previews=rows.slice(1).map((cells,index)=>{
    const values=Object.fromEntries(headers.map((header,column)=>[header,String(cells[column]??"").trim()])),line=index+2;
    let error="";
    if(kind==="contacts"){
      if(!accountNames.has(values.account.toLowerCase()))error="找不到 WhatsApp 账号";
      else if(normalizedPhone(values.phone).length<7)error="手机号无效";
      else if(![values.first_name,values.middle_name,values.last_name,values.alias].some(Boolean))error="联系人姓名不能为空";
      else if(values.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email))error="邮箱格式无效";
    }else{
      if(values.conversation_id&&!UUID.test(values.conversation_id))error="会话 ID 格式无效";
      else if(!values.conversation_id&&(!accountNames.has(values.account.toLowerCase())||normalizedPhone(values.customer_phone).length<7))error="请填写有效会话 ID，或账号与客户号码";
      else if(!/^[A-Za-z]{3}$/.test(values.currency))error="币种应为三位代码";
      else if(!BUSINESS_STATUSES.has(values.business_status||"quotation"))error="订单业务状态无效";
      else if(!parseOrderItems(values.items))error="商品格式应为 SKU|名称|数量|单价，多项用分号分隔";
      else if(values.fees&&!parseOrderFees(values.fees))error="费用格式应为 名称|金额，多项用分号分隔";
    }
    return{line,values,error};
  });
  return{rows:previews,fatal:previews.length?"":"CSV 中没有数据"};
}

function parseOrderItems(value:string){
  const parts=value.split(";").map(item=>item.trim()).filter(Boolean);
  if(!parts.length)return null;
  const items=parts.map(item=>item.split("|").map(value=>value.trim())).map(([sku,name,quantity,unitAmount])=>({sku,name,quantity:Number(quantity),unitAmount:Number(unitAmount)}));
  return items.every(item=>item.sku&&item.name&&Number.isInteger(item.quantity)&&item.quantity>0&&Number.isFinite(item.unitAmount)&&item.unitAmount>=0)?items:null;
}
function parseOrderFees(value:string){
  const parts=value.split(";").map(item=>item.trim()).filter(Boolean);
  const fees=parts.map(item=>item.split("|").map(value=>value.trim())).map(([name,amount])=>({name,amount:Number(amount)}));
  return fees.length&&fees.every(item=>item.name&&Number.isFinite(item.amount)&&item.amount>0)?fees:null;
}

export function DataImportDialog({kind,accounts,request,onToken,onClose,onImported}:{kind:ImportKind;accounts:AccountOption[];request:(path:string,init?:RequestInit)=>Promise<RequestResult>;onToken:(token:string)=>void;onClose:()=>void;onImported:(count:number)=>Promise<void>}){
  const config=CONFIG[kind],inputRef=useRef<HTMLInputElement>(null),[fileName,setFileName]=useState(""),[rows,setRows]=useState<PreviewRow[]>([]),[fatal,setFatal]=useState(""),[busy,setBusy]=useState(false),[submitError,setSubmitError]=useState("");
  const invalid=rows.filter(row=>row.error).length;
  async function choose(file:File){setFileName(file.name);setSubmitError("");try{const result=previewRows(kind,await file.text(),accounts);setRows(result.rows);setFatal(result.fatal);}catch{setRows([]);setFatal("无法读取 CSV 文件");}}
  function template(){downloadCsv(`${kind}-import-template.csv`,config.headers,config.example);}
  async function findAccount(value:string){return accounts.find(account=>account.id.toLowerCase()===value.toLowerCase()||account.name.toLowerCase()===value.toLowerCase());}
  async function importContact(row:PreviewRow){
    const values=row.values,account=await findAccount(values.account);if(!account)throw new Error(`第 ${row.line} 行找不到账号`);
    const phone=normalizedPhone(values.phone),search=await request(`/api/v1/contacts?accountId=${encodeURIComponent(account.id)}&q=${encodeURIComponent(phone)}&limit=100`);
    onToken(search.token);if(!search.response.ok)throw new Error(`第 ${row.line} 行联系人查询失败`);
    const found=(await search.response.json() as {data:Array<Record<string,unknown>>}).data.find(item=>normalizedPhone(String(item.phone??item.phone_e164??""))===phone);
    let id=found?String(found.id):"";
    if(!id){const created=await request("/api/v1/contacts",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({accountId:account.id,phone,firstName:values.first_name,middleName:values.middle_name,lastName:values.last_name,name:values.alias||undefined})});onToken(created.token);const body=await created.response.json().catch(()=>({})) as Record<string,unknown>;if(!created.response.ok)throw new Error(`第 ${row.line} 行：${String(body.message??body.error??"创建失败")}`);id=String(body.id);}
    const existing=found??{},existingEmails=Array.isArray(existing.emails)?existing.emails:[],existingMethods=Array.isArray(existing.methods)?existing.methods:[],existingAddresses=Array.isArray(existing.addresses)?existing.addresses:[];
    const saved=await request(`/api/v1/contacts/${id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({alias:values.alias||existing.alias||"",firstName:values.first_name||existing.firstName||existing.first_name||"",middleName:values.middle_name||existing.middleName||existing.middle_name||"",lastName:values.last_name||existing.lastName||existing.last_name||"",note:values.note||existing.note||"",emails:values.email?[{label:"主要邮箱",email:values.email,isPrimary:true}]:existingEmails,methods:existingMethods,addresses:existingAddresses})});onToken(saved.token);if(!saved.response.ok){const body=await saved.response.json().catch(()=>({})) as Record<string,unknown>;throw new Error(`第 ${row.line} 行：${String(body.message??body.error??"更新失败")}`);}
  }
  async function resolveConversation(row:PreviewRow){
    const values=row.values;if(values.conversation_id)return values.conversation_id;
    const account=await findAccount(values.account);if(!account)throw new Error(`第 ${row.line} 行找不到账号`);
    const phone=normalizedPhone(values.customer_phone),result=await request(`/api/v1/contacts?accountId=${encodeURIComponent(account.id)}&q=${encodeURIComponent(phone)}&limit=100`);onToken(result.token);
    const contacts=(await result.response.json() as {data:Array<Record<string,unknown>>}).data??[],contact=contacts.find(item=>normalizedPhone(String(item.phone??item.phone_e164??""))===phone);
    const conversationId=String(contact?.conversationId??contact?.conversation_id??"");if(!conversationId)throw new Error(`第 ${row.line} 行客户没有可用会话`);return conversationId;
  }
  async function importOrder(row:PreviewRow){
    const values=row.values,conversationId=await resolveConversation(row),items=parseOrderItems(values.items),fees=values.fees?parseOrderFees(values.fees):[];
    const created=await request(`/api/v1/conversations/${conversationId}/orders`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({clientOrderId:crypto.randomUUID(),currency:values.currency.toUpperCase(),businessStatus:values.business_status||"quotation",weightUnit:"kg",description:values.description||undefined,translateOnSend:false,items,fees:fees||[]})});onToken(created.token);
    const body=await created.response.json().catch(()=>({})) as Record<string,unknown>;if(!created.response.ok)throw new Error(`第 ${row.line} 行：${String(body.message??body.error??"创建失败")}`);
    if((values.business_status||"quotation")!=="quotation"){const status=await request(`/api/v1/conversations/${conversationId}/orders/${String(body.orderId)}/status`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({businessStatus:values.business_status})});onToken(status.token);if(!status.response.ok)throw new Error(`第 ${row.line} 行订单已创建，但业务状态保存失败`);}
  }
  async function submit(){setBusy(true);setSubmitError("");try{for(const row of rows)await(kind==="contacts"?importContact(row):importOrder(row));await onImported(rows.length);}catch(reason){setSubmitError(reason instanceof Error?reason.message:"导入失败");setBusy(false);}}
  return <div className="modal-backdrop product-dialog-backdrop" role="presentation"><section className="login-dialog product-import-dialog" role="dialog" aria-modal="true" aria-labelledby="data-import-title"><button className="login-close" onClick={onClose} disabled={busy} aria-label="关闭"><X size={17}/></button><span className="login-logo"><FileText size={20}/></span><h2 id="data-import-title">{config.title}</h2><p>{config.description}</p><div className="product-import-actions"><button className="secondary-action" onClick={template}><Download size={14}/>下载 CSV 模板</button><button className="primary-action" onClick={()=>inputRef.current?.click()}><UploadCloud size={14}/>{fileName||"选择 CSV 文件"}</button><input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void choose(file);event.currentTarget.value="";}}/></div>{fatal&&<span className="login-error">{fatal}</span>}{rows.length>0&&<><div className={`product-import-summary ${invalid?"invalid":""}`}><b>{rows.length} 行数据</b><span>{invalid?`${invalid} 行需要修正`:`校验通过，可导入 ${rows.length} 行`}</span></div><div className="product-import-preview"><table><thead><tr><th>行</th>{config.headers.map(header=><th key={header}>{header}</th>)}<th>校验结果</th></tr></thead><tbody>{rows.slice(0,100).map(row=><tr key={row.line} className={row.error?"invalid":""}><td>{row.line}</td>{config.headers.map(header=><td key={header}>{row.values[header]||"—"}</td>)}<td>{row.error||"通过"}</td></tr>)}</tbody></table></div></>}{submitError&&<span className="login-error">{submitError}</span>}<button className="login-submit" disabled={busy||!rows.length||Boolean(fatal)||invalid>0} onClick={()=>void submit()}>{busy?"正在导入…":`一键导入 ${rows.length} 行`}</button></section></div>;
}
