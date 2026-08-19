import assert from "node:assert/strict";
import test from "node:test";
import { quickReplyVariableNames, renderQuickReplyVariables, type QuickReplyVariableValues } from "../../../app/quick-reply-variables.js";

const values:QuickReplyVariableValues={
  first_name:"Alice",
  middle_name:"Beth",
  last_name:"Smith",
  shipping_address:"Alice Smith\n+8613800000000\nShanghai",
  country:"China",
  company_name:"RelayDesk Trading",
  job_title:"Purchasing Manager",
  province:"Shanghai",
  city:"Shanghai",
  email:"alice@example.com",
  mobile:"+8613900000000",
  whatsapp:"+8613800000000",
};

test("quick reply variables render every supported customer field",()=>{
  const template="Hi {{first_name}} {{middle name}} {{last-name}}\n{{shipping_address}}\n{{country}} {{company name}} {{job-title}} {{province}} {{city}}\n{{email}}\n{{mobile}}\n{{whatsapp}}";
  const rendered=renderQuickReplyVariables(template,values);
  assert.equal(rendered.missing.length,0);
  assert.equal(rendered.unsupported.length,0);
  assert.match(rendered.text,/Hi Alice Beth Smith/);
  assert.match(rendered.text,/China RelayDesk Trading Purchasing Manager Shanghai Shanghai/);
  assert.match(rendered.text,/alice@example\.com/);
  assert.deepEqual(quickReplyVariableNames(template),["first_name","middle_name","last_name","shipping_address","country","company_name","job_title","province","city","email","mobile","whatsapp"]);
});

test("quick reply rendering reports missing and unsupported variables without leaking a partial send",()=>{
  const rendered=renderQuickReplyVariables("Hi {{first_name}} {{email}} {{company}}",{...values,email:""});
  assert.deepEqual(rendered.missing,["email"]);
  assert.deepEqual(rendered.unsupported,["company"]);
  assert.match(rendered.text,/{{email}}/);
  assert.match(rendered.text,/{{company}}/);
});
