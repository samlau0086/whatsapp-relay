"use client";

import { Check, Download, FileSpreadsheet, Plus, RefreshCw, Trash2, UploadCloud, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { confirmAction } from "./confirmation-ui";
import { dateFileSuffix, downloadCsv } from "./csv-transfer";
import { parseShippingRuleCsv, SHIPPING_RULE_CSV_HEADERS, shippingRuleCsvKey, shippingRuleCsvRows, validateShippingRuleCsvImport, type ShippingRuleCsvPreview, type ShippingRuleCsvRule } from "./shipping-rule-csv";
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

function csvDraft(rule:ShippingRuleCsvRule):RuleDraft{
  return{id:crypto.randomUUID(),...rule};
}

function ShippingRuleCsvDialog({classes,currentRules,onClose,onApply}:{classes:ShippingClass[];currentRules:RuleDraft[];onClose:()=>void;onApply:(rules:RuleDraft[],mode:"replace"|"append")=>void}){
  const inputRef=useRef<HTMLInputElement>(null);
  const [mode,setMode]=useState<"replace"|"append">("replace");
  const [fileName,setFileName]=useState("");
  const [rows,setRows]=useState<ShippingRuleCsvPreview[]>([]);
  const [rules,setRules]=useState<ShippingRuleCsvRule[]>([]);
  const [fatal,setFatal]=useState("");
  const currentKeys=useMemo(()=>new Set(currentRules.map(rule=>ruleKey(rule))),[currentRules]);
  const rowError=(row:ShippingRuleCsvPreview)=>row.error||(mode==="append"&&row.rule&&currentKeys.has(shippingRuleCsvKey(row.rule))?"与当前模板已有规则重复":"");
  const invalid=rows.filter(row=>rowError(row)).length;
  const modeError=validateShippingRuleCsvImport(mode,rules,currentRules);
  async function choose(file:File){
    setFileName(file.name);
    try{const result=parseShippingRuleCsv(await file.text(),classes);setRows(result.rows);setRules(result.rules);setFatal(result.fatal);}
    catch{setRows([]);setRules([]);setFatal("无法读取 CSV 文件");}
  }
  function template(){
    downloadCsv("shipping-rules-import-template.csv",[...SHIPPING_RULE_CSV_HEADERS],[
      ["","","","quantity","5.00","1.00","","","","",""],
      ["US","California","","weight","","","1","0.5","kg","12.00","3.00"],
    ]);
  }
  return <div className="modal-backdrop shipping-csv-backdrop" role="presentation">
    <section className="shipping-csv-dialog" role="dialog" aria-modal="true" aria-labelledby="shipping-csv-title">
      <header><span><FileSpreadsheet size={20}/></span><div><h2 id="shipping-csv-title">CSV 导入运费规则</h2><p>先校验预览，再更新当前模板草稿；导入后仍需保存模板。</p></div><button onClick={onClose} aria-label="关闭 CSV 导入"><X size={17}/></button></header>
      <div className="shipping-csv-mode" role="group" aria-label="导入模式">
        <button className={mode==="replace"?"active":""} onClick={()=>setMode("replace")}><b>覆盖当前规则</b><small>CSV 必须包含全球默认规则</small></button>
        <button className={mode==="append"?"active":""} onClick={()=>setMode("append")}><b>追加到当前规则</b><small>不能与现有地区和 class 重复</small></button>
      </div>
      <div className="shipping-csv-actions"><button className="secondary-action" onClick={template}><Download size={14}/>下载 CSV 模板</button><button className="primary-action" onClick={()=>inputRef.current?.click()}><UploadCloud size={14}/>{fileName||"选择 CSV 文件"}</button><input ref={inputRef} type="file" accept=".csv,text/csv" hidden onChange={event=>{const file=event.target.files?.[0];if(file)void choose(file);event.currentTarget.value="";}}/></div>
      <div className="shipping-csv-hint"><code>destination_country_code</code> 使用两位国家代码；<code>shipping_class</code> 可填写名称或 ID；全球与区域默认规则的 class 留空。</div>
      {fatal&&<span className="login-error">{fatal}</span>}
      {rows.length>0&&<><div className={`shipping-csv-summary ${invalid||modeError?"invalid":""}`}><span><b>{rows.length}</b> 行规则</span><span><b>{rows.length-invalid}</b> 行可用</span><span><b>{invalid}</b> 行错误</span></div><div className="shipping-csv-preview"><table><thead><tr><th>行</th><th>地区</th><th>Shipping class</th><th>模式</th><th>计费参数</th><th>校验结果</th></tr></thead><tbody>{rows.slice(0,100).map(row=>{const error=rowError(row),values=row.values,region=values.destination_country_code?[values.destination_country_code,values.destination_province].filter(Boolean).join(" · "):"全球",parameters=values.calculation_mode.toLocaleLowerCase()==="weight"?`${values.first_weight} + ${values.additional_weight} ${values.weight_unit} / ${values.first_weight_price} + ${values.additional_weight_price}`:`${values.first_item_price} + ${values.additional_item_price}`;return <tr key={row.line} className={error?"invalid":""}><td>{row.line}</td><td>{region}</td><td>{values.shipping_class||"默认"}</td><td>{values.calculation_mode}</td><td>{parameters}</td><td>{error||"通过"}</td></tr>;})}</tbody></table>{rows.length>100&&<p>仅展示前 100 行，其余规则也已校验。</p>}</div></>}
      {modeError&&<span className="login-error">{modeError}</span>}
      <footer><button className="secondary-action" onClick={onClose}>取消</button><button className="primary-action" disabled={!rows.length||Boolean(fatal)||invalid>0||Boolean(modeError)} onClick={()=>onApply(rules.map(csvDraft),mode)}><Check size={14}/>{mode==="replace"?`覆盖为 ${rules.length} 条规则`:`追加 ${rules.length} 条规则`}</button></footer>
    </section>
  </div>;
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
  const [csvOpen,setCsvOpen]=useState(false);

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
  function exportRules(){
    if(!draft)return;
    const safeName=draft.name.trim().replace(/[^\p{L}\p{N}._-]+/gu,"-").replace(/^-+|-+$/g,"")||"shipping-template";
    downloadCsv(`${safeName}-rules-${dateFileSuffix()}.csv`,[...SHIPPING_RULE_CSV_HEADERS],shippingRuleCsvRows(draft.rules,classes));
    onToast(`已导出 ${draft.rules.length} 条运费规则`);
  }
  function applyCsv(rules:RuleDraft[],mode:"replace"|"append"){
    setDraft(value=>value?{...value,rules:(mode==="replace"?rules:[...value.rules,...rules]).sort((a,b)=>Number(isGlobalDefault(b))-Number(isGlobalDefault(a)))}:value);
    setCsvOpen(false);setError("");onToast(`已${mode==="replace"?"覆盖":"追加"} ${rules.length} 条规则，请保存模板`);
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
    const templateId=draft.id,templateName=draft.name.trim()||"未命名模板";
    const confirmed=await confirmAction(
      `确定要删除运费模板“${templateName}”吗？\n模板中的所有地区、Shipping class 和计费规则将一并删除，且无法恢复。`,
      {title:"删除运费模板",confirmLabel:"删除模板",cancelLabel:"取消",tone:"danger"},
    );
    if(!confirmed)return;
    setBusy(true);
    const result=await request(`/api/v1/admin/shipping-templates/${templateId}`,{method:"DELETE"});
    onToken(result.token);setBusy(false);
    if(result.response.ok){setDraft(null);await load();onToast(`已删除运费模板“${templateName}”`);}else setError("删除运费模板失败");
  }

  if(loading)return <p>正在读取运费设置…</p>;
  const regionCount=new Set(draft?.rules.filter(rule=>rule.destinationCountryCode).map(rule=>`${rule.destinationCountryCode}|${rule.destinationProvince.toLocaleLowerCase()}`)??[]).size;
  const classCoverage=new Set(draft?.rules.filter(rule=>rule.shippingClassId).map(rule=>rule.shippingClassId)??[]).size;
  return <><div className="shipping-settings-layout">
    <aside className="shipping-class-panel">
      <header><span><h3>Shipping classes</h3><p>产品的单选运费类别</p></span><b>{classes.filter(item=>item.enabled).length}/{classes.length}</b></header>
      <div className="shipping-class-create"><input value={newClassName} placeholder="新增 class，例如 Heavy" onChange={event=>setNewClassName(event.target.value)}/><button disabled={busy||!newClassName.trim()} onClick={()=>void createClass()} aria-label="新增 shipping class"><Plus size={15}/></button></div>
      <div className="shipping-class-list">{classes.map(item=><div className={`shipping-class-row ${item.enabled?"":"disabled"}`} key={item.id}><span><i/><b>{item.name}</b><small>{item.enabled?"启用中":"已停用"}</small></span><button disabled={busy} onClick={()=>void toggleClass(item)}>{item.enabled?"停用":"启用"}</button></div>)}{!classes.length&&<p>暂无 shipping class</p>}</div>
      <footer>停用不会改变产品和历史订单快照。</footer>
    </aside>
    <section className="settings-provider-section shipping-template-panel">
      <div className="shipping-template-head"><div><span className="shipping-eyebrow">ORDER SHIPPING</span><h2>运费模板</h2><p>目的地按省份 → 国家 → 全球匹配，每一级再应用 shipping class。</p></div><div><button className="secondary-action icon-only" onClick={()=>void load()} title="刷新"><RefreshCw size={14}/></button><button className="secondary-action" disabled={!draft} onClick={()=>setCsvOpen(true)}><UploadCloud size={14}/>导入规则</button><button className="secondary-action" disabled={!draft} onClick={exportRules}><Download size={14}/>导出规则</button><button className="primary-action" onClick={createTemplate}><Plus size={14}/>新增模板</button></div></div>
      <div className="shipping-template-switcher"><span>模板</span><nav>{templates.map(item=><button key={item.id} className={draft?.id===item.id?"active":""} onClick={()=>{setDraft(editTemplate(item));setError("");}}><b>{item.name}</b><small>{item.currency}{item.isDefault?" · 默认":""}{!item.enabled?" · 停用":""}</small></button>)}{!templates.length&&<small>尚未创建模板</small>}</nav></div>
      {draft?<div className="shipping-template-editor">
        <section className="shipping-template-config">
          <div className="provider-form-grid"><label>模板名称<input value={draft.name} onChange={event=>setDraft(value=>value&&({...value,name:event.target.value}))}/></label><label>模板币种<select value={draft.currency} onChange={event=>setDraft(value=>value&&({...value,currency:event.target.value}))}>{currencies.map(item=><option key={item.code} value={item.code}>{item.code} · {item.name}</option>)}</select></label></div>
          <div className="shipping-template-switches"><label className="provider-toggle"><input type="checkbox" checked={draft.enabled} onChange={event=>setDraft(value=>value&&({...value,enabled:event.target.checked,isDefault:event.target.checked?value.isDefault:false}))}/><span>启用模板</span></label><label className="provider-toggle"><input type="checkbox" checked={draft.isDefault} disabled={!draft.enabled} onChange={event=>setDraft(value=>value&&({...value,isDefault:event.target.checked}))}/><span>默认模板</span></label></div>
        </section>
        <div className="shipping-template-summary"><span><b>{draft.rules.length}</b><small>规则总数</small></span><span><b>{regionCount}</b><small>目的地区域</small></span><span><b>{classCoverage}</b><small>Class 覆盖</small></span><span><b>{draft.currency}</b><small>计费币种</small></span></div>
        <div className="shipping-rules-heading"><span><h3>计费规则</h3><p>规则越具体，匹配优先级越高。全球默认规则始终保留。</p></span><small>{duplicateKeys.size?`${duplicateKeys.size} 组重复规则`:"规则校验通过"}</small></div>
        <div className="shipping-rule-list">{draft.rules.map((rule,index)=>{
          const globalDefault=isGlobalDefault(rule),duplicate=duplicateKeys.has(ruleKey(rule)),className=classes.find(item=>item.id===rule.shippingClassId)?.name;
          return <article key={rule.id} className={`${duplicate?"invalid ":""}${globalDefault?"global-default":""}`}>
            <header><span className="shipping-rule-index">{String(index+1).padStart(2,"0")}</span><span className="shipping-rule-title"><b>{globalDefault?"全球默认规则":className??"区域默认规则"}</b><small><em>{destinationLabel(rule)}</em><em>{className??"默认 class"}</em></small></span><label className="shipping-mode-select"><span>计费方式</span><select value={rule.mode} onChange={event=>changeRule(rule.id,{mode:event.target.value as RuleDraft["mode"]})}><option value="quantity">按数量</option><option value="weight">按重量</option></select></label>{!globalDefault&&<button className="shipping-rule-delete" onClick={()=>setDraft(value=>value?{...value,rules:value.rules.filter(item=>item.id!==rule.id)}:value)} aria-label="删除规则"><Trash2 size={14}/></button>}</header>
            {!globalDefault&&<div className="shipping-rule-destination"><label>国家代码<input value={rule.destinationCountryCode} maxLength={2} placeholder="全球留空" onChange={event=>changeRule(rule.id,{destinationCountryCode:event.target.value.toUpperCase(),...(event.target.value?{}:{destinationProvince:""})})}/></label><label>省份 / 州<input value={rule.destinationProvince} maxLength={100} disabled={!rule.destinationCountryCode} placeholder="国家级规则留空" onChange={event=>changeRule(rule.id,{destinationProvince:event.target.value})}/></label><label>Shipping class<select value={rule.shippingClassId} onChange={event=>changeRule(rule.id,{shippingClassId:event.target.value})}><option value="">区域默认</option>{classes.map(item=><option key={item.id} value={item.id}>{item.name}{item.enabled?"":" · 已停用"}</option>)}</select></label></div>}
            <div className={`shipping-price-fields ${rule.mode}`}>{rule.mode==="quantity"?<><label>首件价格<div><span>{draft.currency}</span><input value={rule.firstItemPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{firstItemPrice:event.target.value})}/></div></label><label>续件价格<div><span>{draft.currency}</span><input value={rule.additionalItemPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{additionalItemPrice:event.target.value})}/></div></label></>:<><label>首重<input value={rule.firstWeight} inputMode="decimal" onChange={event=>changeRule(rule.id,{firstWeight:event.target.value})}/></label><label>续重<input value={rule.additionalWeight} inputMode="decimal" onChange={event=>changeRule(rule.id,{additionalWeight:event.target.value})}/></label><label>单位<select value={rule.weightUnit} onChange={event=>changeRule(rule.id,{weightUnit:event.target.value as WeightUnit})}>{WEIGHT_UNITS.map(unit=><option key={unit}>{unit}</option>)}</select></label><label>首重价格<div><span>{draft.currency}</span><input value={rule.firstWeightPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{firstWeightPrice:event.target.value})}/></div></label><label>续重价格<div><span>{draft.currency}</span><input value={rule.additionalWeightPrice} inputMode="decimal" onChange={event=>changeRule(rule.id,{additionalWeightPrice:event.target.value})}/></div></label></>}</div>
            <RuleExample rule={rule} currency={draft.currency}/>
            {duplicate&&<small className="login-error">相同地区与 shipping class 的规则重复</small>}
          </article>;
        })}</div>
        <section className="shipping-rule-composer"><header><span><Plus size={15}/><b>添加地区或 class 覆盖规则</b></span><small>国家留空表示全球；class 留空表示该区域默认。</small></header><div className="shipping-rule-add">
          <label>国家代码<input value={newRuleCountry} maxLength={2} placeholder="例如 US" onChange={event=>{setNewRuleCountry(event.target.value.toUpperCase());if(!event.target.value)setNewRuleProvince("");setError("");}}/></label>
          <label>省份 / 州<input value={newRuleProvince} maxLength={100} disabled={!newRuleCountry} placeholder="可选，例如 California" onChange={event=>{setNewRuleProvince(event.target.value);setError("");}}/></label>
          <label>Shipping class<select value={newRuleClassId} onChange={event=>{setNewRuleClassId(event.target.value);setError("");}}><option value="">区域默认</option>{classes.filter(item=>item.enabled).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <button className="primary-action" onClick={addRule}><Plus size={14}/>添加规则</button>
        </div></section>
        {error&&<span className="login-error shipping-template-error">{error}</span>}<footer><button className="danger-text" disabled={!draft.id||draft.isDefault||busy} onClick={()=>void remove()}><Trash2 size={14}/>删除模板</button><span>修改仅保存在当前草稿中</span><button className="primary-action" disabled={busy||!draft.name.trim()||duplicateKeys.size>0} onClick={()=>void save()}><Check size={14}/>{busy?"保存中…":"保存模板"}</button></footer>
      </div>:<div className="shipping-template-empty"><FileSpreadsheet size={28}/><b>还没有运费模板</b><p>新建模板后即可设置地区、shipping class 和计费规则。</p><button className="primary-action" onClick={createTemplate}><Plus size={14}/>新增模板</button></div>}
    </section>
  </div>{csvOpen&&draft&&<ShippingRuleCsvDialog classes={classes} currentRules={draft.rules} onClose={()=>setCsvOpen(false)} onApply={applyCsv}/>}</>;
}
