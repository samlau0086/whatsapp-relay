"use client";

import { Check, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { WEIGHT_UNITS, type WeightUnit } from "./weight";

type RequestResult={response:Response;token:string};
type ShippingClass={id:string;name:string;enabled:boolean};
type Rule={
  shippingClassId:string|null;
  shippingClassName?:string|null;
  destinationCountryCode:string|null;
  destinationProvince:string|null;
  mode:"quantity"|"weight";
  firstItemPrice?:number;
  additionalItemPrice?:number;
  firstWeight?:number;
  additionalWeight?:number;
  weightUnit?:WeightUnit;
  firstWeightPrice?:number;
  additionalWeightPrice?:number;
};
type Template={id:string;name:string;currency:string;enabled:boolean;isDefault:boolean;version:number;rules:Rule[]};
type RuleDraft={
  id:string;
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
type TemplateDraft={id:string;name:string;currency:string;enabled:boolean;isDefault:boolean;rules:RuleDraft[]};

const newRule=(source?:Partial<Rule>):RuleDraft=>({
  id:crypto.randomUUID(),
  shippingClassId:source?.shippingClassId??"",
  destinationCountryCode:source?.destinationCountryCode??"",
  destinationProvince:source?.destinationProvince??"",
  mode:source?.mode??"quantity",
  firstItemPrice:String(source?.firstItemPrice??0),
  additionalItemPrice:String(source?.additionalItemPrice??0),
  firstWeight:String(source?.firstWeight??1),
  additionalWeight:String(source?.additionalWeight??1),
  weightUnit:source?.weightUnit??"kg",
  firstWeightPrice:String(source?.firstWeightPrice??0),
  additionalWeightPrice:String(source?.additionalWeightPrice??0),
});
const isGlobalDefault=(rule:RuleDraft)=>!rule.shippingClassId&&!rule.destinationCountryCode&&!rule.destinationProvince;
const ruleKey=(rule:Pick<RuleDraft,"shippingClassId"|"destinationCountryCode"|"destinationProvince">)=>`${rule.shippingClassId}|${rule.destinationCountryCode.toUpperCase()}|${rule.destinationProvince.trim().toLocaleLowerCase()}`;
const editTemplate=(item:Template):TemplateDraft=>({
  id:item.id,
  name:item.name,
  currency:item.currency,
  enabled:item.enabled,
  isDefault:item.isDefault,
  rules:item.rules.map(rule=>newRule(rule)).sort((a,b)=>Number(isGlobalDefault(b))-Number(isGlobalDefault(a))),
});

function destinationLabel(rule:RuleDraft){
  if(!rule.destinationCountryCode)return"全球";
  return rule.destinationProvince?`${rule.destinationCountryCode.toUpperCase()} · ${rule.destinationProvince}`:rule.destinationCountryCode.toUpperCase();
}

function RuleExample({rule,currency}:{rule:RuleDraft;currency:string}){
  if(rule.mode==="quantity"){
    const amount=Number(rule.firstItemPrice||0)+2*Number(rule.additionalItemPrice||0);
    return <small className="shipping-rule-example">示例：3 件商品 = {currency} {amount.toFixed(2)}</small>;
  }
  const first=Number(rule.firstWeight||0),step=Number(rule.additionalWeight||0),sample=first+step*1.5,bands=step>0?Math.ceil((sample-first)/step):0,amount=Number(rule.firstWeightPrice||0)+bands*Number(rule.additionalWeightPrice||0);
  return <small className="shipping-rule-example">示例：{sample.toFixed(2)} {rule.weightUnit} = {currency} {amount.toFixed(2)}</small>;
}

export function ShippingSettings({request,onToken,onToast}:{request:(path:string,init?:RequestInit)=>Promise<RequestResult>;onToken:(token:string)=>void;onToast:(text:string)=>void}){
  const [classes,setClasses]=useState<ShippingClass[]>([]);
  const [templates,setTemplates]=useState<Template[]>([]);
  const [currencies,setCurrencies]=useState<Array<{code:string;name:string}>>([]);
  const [draft,setDraft]=useState<TemplateDraft|null>(null);
  const [newClassName,setNewClassName]=useState("");
  const [newRuleClassId,setNewRuleClassId]=useState("");
  const [newRuleCountry,setNewRuleCountry]=useState("");
  const [newRuleProvince,setNewRuleProvince]=useState("");
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  const load=useCallback(async()=>{
    setLoading(true);
    try{
      const [a,b,c]=await Promise.all([request("/api/v1/admin/shipping-classes"),request("/api/v1/admin/shipping-templates"),request("/api/v1/currencies")]);
      onToken(a.token);
      const classBody=await a.response.json() as {data?:ShippingClass[];error?:string};
      const templateBody=await b.response.json() as {data?:Template[];error?:string};
      const currencyBody=await c.response.json() as {currencies?:Array<{code:string;name:string}>};
      if(!a.response.ok||!b.response.ok)throw new Error(classBody.error??templateBody.error??"加载失败");
      setClasses(classBody.data??[]);
      setTemplates(templateBody.data??[]);
      setCurrencies(currencyBody.currencies??[]);
      setDraft(current=>{
        const selected=(templateBody.data??[]).find(item=>item.id===current?.id)??(templateBody.data??[])[0];
        return selected?editTemplate(selected):null;
      });
      setError("");
    }catch(reason){setError(reason instanceof Error?reason.message:"加载失败");}
    finally{setLoading(false);}
  },[request,onToken]);

  useEffect(()=>{const timer=window.setTimeout(()=>void load(),0);return()=>window.clearTimeout(timer);},[load]);
  const duplicateKeys=useMemo(()=>{if(!draft)return new Set<string>();const counts=new Map<string,number>();draft.rules.forEach(rule=>counts.set(ruleKey(rule),(counts.get(ruleKey(rule))??0)+1));return new Set([...counts].filter(([,count])=>count>1).map(([key])=>key));},[draft]);
  function changeRule(id:string,change:Partial<RuleDraft>){setDraft(value=>value?{...value,rules:value.rules.map(rule=>rule.id===id?{...rule,...change}:rule)}:value);}

  async function createClass(){
    if(!newClassName.trim())return;
    setBusy(true);
    const result=await request("/api/v1/admin/shipping-classes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:newClassName.trim(),enabled:true})});
    onToken(result.token);setBusy(false);
    if(!result.response.ok){setError("新增 shipping class 失败");return;}
    setNewClassName("");await load();
  }
  async function toggleClass(item:ShippingClass){
    setBusy(true);
    const result=await request(`/api/v1/admin/shipping-classes/${item.id}`,{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:!item.enabled})});
    onToken(result.token);setBusy(false);
    if(result.response.ok)await load();else setError("更新 shipping class 失败");
  }
  function createTemplate(){setDraft({id:"",name:"新运费模板",currency:currencies[0]?.code??"USD",enabled:true,isDefault:templates.length===0,rules:[newRule()]});}
  function addRule(){
    if(newRuleProvince.trim()&&!/^[A-Za-z]{2}$/.test(newRuleCountry.trim())){setError("设置省份时必须填写两位国家代码");return;}
    const next=newRule({shippingClassId:newRuleClassId||null,destinationCountryCode:newRuleCountry.trim().toUpperCase()||null,destinationProvince:newRuleProvince.trim()||null});
    if(draft?.rules.some(rule=>ruleKey(rule)===ruleKey(next))){setError("相同地区与 shipping class 的规则已存在");return;}
    setDraft(value=>value?{...value,rules:[...value.rules,next]}:value);
    setNewRuleClassId("");setNewRuleCountry("");setNewRuleProvince("");setError("");
  }
  async function save(){
    if(!draft)return;
    if(duplicateKeys.size){setError("相同地区与 shipping class 不能配置重复规则");return;}
    setBusy(true);setError("");
    const rules=draft.rules.map(rule=>({
      shippingClassId:rule.shippingClassId||null,
      destinationCountryCode:rule.destinationCountryCode.trim().toUpperCase()||null,
      destinationProvince:rule.destinationProvince.trim()||null,
      mode:rule.mode,
      ...(rule.mode==="quantity"
        ?{firstItemPrice:Number(rule.firstItemPrice),additionalItemPrice:Number(rule.additionalItemPrice)}
        :{firstWeight:Number(rule.firstWeight),additionalWeight:Number(rule.additionalWeight),weightUnit:rule.weightUnit,firstWeightPrice:Number(rule.firstWeightPrice),additionalWeightPrice:Number(rule.additionalWeightPrice)}),
    }));
    const payload={name:draft.name.trim(),currency:draft.currency,enabled:draft.enabled,isDefault:draft.isDefault,rules};
    const result=await request(draft.id?`/api/v1/admin/shipping-templates/${draft.id}`:"/api/v1/admin/shipping-templates",{method:draft.id?"PUT":"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    onToken(result.token);setBusy(false);
    if(!result.response.ok){const body=await result.response.json().catch(()=>({})) as {error?:string;message?:string};setError(body.message??body.error??"保存失败");return;}
    const saved=await result.response.json() as Template;await load();setDraft(editTemplate(saved));onToast("运费模板已保存");
  }
  async function remove(){
    if(!draft?.id||draft.isDefault)return;
    setBusy(true);
    const result=await request(`/api/v1/admin/shipping-templates/${draft.id}`,{method:"DELETE"});
    onToken(result.token);setBusy(false);
    if(result.response.ok){setDraft(null);await load();}else setError("无法删除默认模板");
  }

  if(loading)return <p>正在读取运费设置…</p>;
  return <div className="shipping-settings-layout">
    <aside className="shipping-class-panel">
      <h3>Shipping classes</h3><p>停用不会改变产品和历史订单快照。</p>
      <div className="shipping-class-create"><input value={newClassName} placeholder="例如：Heavy" onChange={event=>setNewClassName(event.target.value)}/><button disabled={busy||!newClassName.trim()} onClick={()=>void createClass()}><Plus size={13}/></button></div>
      {classes.map(item=><div className="shipping-class-row" key={item.id}><span><b>{item.name}</b><small>{item.enabled?"启用":"停用"}</small></span><button disabled={busy} onClick={()=>void toggleClass(item)}>{item.enabled?"停用":"启用"}</button></div>)}
    </aside>
    <section className="settings-provider-section shipping-template-panel">
      <div className="settings-section-head"><div><h2>运费模板</h2><p>先按省份、国家、全球匹配地区，再匹配 shipping class；未命中时使用全球默认规则。</p></div><div><button className="secondary-action" onClick={()=>void load()}><RefreshCw size={14}/>刷新</button><button className="primary-action" onClick={createTemplate}><Plus size={14}/>新增模板</button></div></div>
      <nav className="order-settings-tabs">{templates.map(item=><button key={item.id} className={draft?.id===item.id?"active":""} onClick={()=>setDraft(editTemplate(item))}>{item.name}{item.isDefault?" · 默认":""}{!item.enabled?" · 停用":""}</button>)}</nav>
      {draft?<div className="shipping-template-editor">
        <div className="provider-form-grid"><label>模板名称<input value={draft.name} onChange={event=>setDraft(value=>value&&({...value,name:event.target.value}))}/></label><label>模板币种<select value={draft.currency} onChange={event=>setDraft(value=>value&&({...value,currency:event.target.value}))}>{currencies.map(item=><option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label></div>
        <div className="shipping-template-switches"><label className="provider-toggle"><input type="checkbox" checked={draft.enabled} onChange={event=>setDraft(value=>value&&({...value,enabled:event.target.checked,isDefault:event.target.checked?value.isDefault:false}))}/><span>启用</span></label><label className="provider-toggle"><input type="checkbox" checked={draft.isDefault} disabled={!draft.enabled} onChange={event=>setDraft(value=>value&&({...value,isDefault:event.target.checked}))}/><span>默认模板</span></label></div>
        <div className="shipping-rule-list">{draft.rules.map(rule=>{
          const globalDefault=isGlobalDefault(rule),duplicate=duplicateKeys.has(ruleKey(rule));
          return <article key={rule.id} className={duplicate?"invalid":""}>
            <header><span><b>{globalDefault?"全球默认规则":classes.find(item=>item.id===rule.shippingClassId)?.name??"默认 class"}</b><small>{destinationLabel(rule)}</small></span><select value={rule.mode} onChange={event=>changeRule(rule.id,{mode:event.target.value as RuleDraft["mode"]})}><option value="quantity">按数量</option><option value="weight">按重量</option></select>{!globalDefault&&<button onClick={()=>setDraft(value=>value?{...value,rules:value.rules.filter(item=>item.id!==rule.id)}:value)} aria-label="删除规则"><Trash2 size={13}/></button>}</header>
            {!globalDefault&&<div className="shipping-rule-destination"><label>国家代码<input value={rule.destinationCountryCode} maxLength={2} placeholder="例如：CN" onChange={event=>changeRule(rule.id,{destinationCountryCode:event.target.value.toUpperCase(),...(event.target.value?{}:{destinationProvince:""})})}/></label><label>省份 / 州<input value={rule.destinationProvince} maxLength={100} disabled={!rule.destinationCountryCode} placeholder="例如：广东省" onChange={event=>changeRule(rule.id,{destinationProvince:event.target.value})}/></label><label>Shipping class<select value={rule.shippingClassId} onChange={event=>changeRule(rule.id,{shippingClassId:event.target.value})}><option value="">区域默认</option>{classes.map(item=><option key={item.id} value={item.id}>{item.name}{item.enabled?"":" · 已停用"}</option>)}</select></label></div>}
            {rule.mode==="quantity"?<div className="provider-form-grid"><label>首件价格<input value={rule.firstItemPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{firstItemPrice:event.target.value})}/></label><label>续件价格<input value={rule.additionalItemPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{additionalItemPrice:event.target.value})}/></label></div>:<div className="provider-form-grid"><label>首重<input value={rule.firstWeight} inputMode="decimal" onChange={event=>changeRule(rule.id,{firstWeight:event.target.value})}/></label><label>续重<input value={rule.additionalWeight} inputMode="decimal" onChange={event=>changeRule(rule.id,{additionalWeight:event.target.value})}/></label><label>单位<select value={rule.weightUnit} onChange={event=>changeRule(rule.id,{weightUnit:event.target.value as WeightUnit})}>{WEIGHT_UNITS.map(unit=><option key={unit}>{unit}</option>)}</select></label><label>首重价格<input value={rule.firstWeightPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{firstWeightPrice:event.target.value})}/></label><label>续重价格<input value={rule.additionalWeightPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{additionalWeightPrice:event.target.value})}/></label></div>}
            <RuleExample rule={rule} currency={draft.currency}/>
            {duplicate&&<small className="login-error">地区与 shipping class 重复</small>}
          </article>;
        })}</div>
        <div className="shipping-rule-add">
          <label>国家代码<input value={newRuleCountry} maxLength={2} placeholder="留空代表全球" onChange={event=>{setNewRuleCountry(event.target.value.toUpperCase());if(!event.target.value)setNewRuleProvince("");}}/></label>
          <label>省份 / 州<input value={newRuleProvince} maxLength={100} disabled={!newRuleCountry} placeholder="可选" onChange={event=>setNewRuleProvince(event.target.value)}/></label>
          <label>Shipping class<select value={newRuleClassId} onChange={event=>setNewRuleClassId(event.target.value)}><option value="">区域默认</option>{classes.filter(item=>item.enabled).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button onClick={addRule}><Plus size={13}/>添加规则</button>
        </div>
        {error&&<span className="login-error">{error}</span>}<footer><button className="danger-text" disabled={!draft.id||draft.isDefault||busy} onClick={()=>void remove()}><Trash2 size={14}/>删除</button><button className="primary-action" disabled={busy||!draft.name.trim()||duplicateKeys.size>0} onClick={()=>void save()}><Check size={14}/>{busy?"保存中…":"保存模板"}</button></footer>
      </div>:<p className="order-empty-fees">暂无模板，请先新增。</p>}
    </section>
  </div>;
}
