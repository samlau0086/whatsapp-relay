import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseShippingRuleCsv, shippingRuleCsvRows, validateShippingRuleCsvImport } from "../../../app/shipping-rule-csv.js";

const classes=[{id:"10000000-0000-4000-8000-000000000001",name:"Heavy"}];
const headers="destination_country_code,destination_province,shipping_class,calculation_mode,first_item_price,additional_item_price,first_weight,additional_weight,weight_unit,first_weight_price,additional_weight_price";

test("shipping rule CSV parses regional quantity and weight rules",()=>{
  const csv=`${headers}\n,,,quantity,5.00,1.00,,,,,\nUS,California,Heavy,weight,,,1,0.5,kg,12.00,3.00\n`;
  const result=parseShippingRuleCsv(csv,classes);
  assert.equal(result.fatal,"");
  assert.equal(result.rows.filter(row=>row.error).length,0);
  assert.equal(result.rules.length,2);
  assert.deepEqual(result.rules[1],{
    shippingClassId:classes[0].id,
    destinationCountryCode:"US",
    destinationProvince:"California",
    mode:"weight",
    firstItemPrice:"",
    additionalItemPrice:"",
    firstWeight:"1",
    additionalWeight:"0.5",
    weightUnit:"kg",
    firstWeightPrice:"12.00",
    additionalWeightPrice:"3.00",
  });
});

test("shipping rule CSV rejects unknown classes, duplicates, and mixed mode fields",()=>{
  const result=parseShippingRuleCsv(`${headers}\n,,,quantity,5,1,,,,,\nUS,,Missing,quantity,5,1,,,,,\nUS,,Heavy,weight,5,,1,1,kg,8,2\nUS,,Heavy,quantity,5,1,,,,,\nUS,,Heavy,quantity,6,2,,,,,\n`,classes);
  assert.match(result.rows[1].error,/不存在/);
  assert.match(result.rows[2].error,/不能填写数量价格字段/);
  assert.match(result.rows[4].error,/重复/);
});

test("shipping rule CSV import modes protect the global default and current rules",()=>{
  const parsed=parseShippingRuleCsv(`${headers}\n,,,quantity,5,1,,,,,\nUS,,Heavy,quantity,8,2,,,,,\n`,classes).rules;
  assert.equal(validateShippingRuleCsvImport("replace",parsed,[]),"");
  assert.match(validateShippingRuleCsvImport("append",parsed,[]),/不能包含全球默认规则/);
  assert.match(validateShippingRuleCsvImport("replace",parsed.slice(1),[]),/全球默认规则/);
  assert.match(validateShippingRuleCsvImport("append",parsed.slice(1),parsed),/重复/);
});

test("shipping rule CSV export preserves the canonical column order",()=>{
  const parsed=parseShippingRuleCsv(`${headers}\nUS,California,Heavy,weight,,,1,0.5,kg,12.00,3.00\n`,classes).rules;
  assert.deepEqual(shippingRuleCsvRows(parsed,classes),[["US","California","Heavy","weight","","","1","0.5","kg","12.00","3.00"]]);
});

test("shipping settings exposes import, export, preview, and both import modes",async()=>{
  const component=await readFile(new URL("../../../app/shipping-settings.tsx",import.meta.url),"utf8");
  assert.match(component,/导入规则/);
  assert.match(component,/导出规则/);
  assert.match(component,/覆盖当前规则/);
  assert.match(component,/追加到当前规则/);
  assert.match(component,/shipping-csv-preview/);
});

test("shipping template deletion requires confirmation before the delete request",async()=>{
  const component=await readFile(new URL("../../../app/shipping-settings.tsx",import.meta.url),"utf8");
  const confirmation=component.indexOf("await confirmAction(");
  const cancellationGuard=component.indexOf("if(!confirmed)return;",confirmation);
  const deletionRequest=component.indexOf('method:"DELETE"',confirmation);
  assert.ok(confirmation>=0);
  assert.ok(cancellationGuard>confirmation);
  assert.ok(deletionRequest>cancellationGuard);
});
