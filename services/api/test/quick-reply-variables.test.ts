import assert from "node:assert/strict";
import test from "node:test";
import { quickReplyVariableNames, renderQuickReplyVariables, type QuickReplyVariableValues } from "../../../app/quick-reply-variables.js";

const values:QuickReplyVariableValues={
  first_name:"Alice",
  middle_name:"Beth",
  last_name:"Smith",
  shipping_address:"Alice Smith\n+8613800000000\nShanghai",
  email:"alice@example.com",
  mobile:"+8613900000000",
  whatsapp:"+8613800000000",
};

test("quick reply variables render every supported customer field",()=>{
  const template="Hi {{first_name}} {{middle name}} {{last-name}}\n{{shipping_address}}\n{{email}}\n{{mobile}}\n{{whatsapp}}";
  const rendered=renderQuickReplyVariables(template,values);
  assert.equal(rendered.missing.length,0);
  assert.equal(rendered.unsupported.length,0);
  assert.match(rendered.text,/Hi Alice Beth Smith/);
  assert.match(rendered.text,/alice@example\.com/);
  assert.deepEqual(quickReplyVariableNames(template),["first_name","middle_name","last_name","shipping_address","email","mobile","whatsapp"]);
});

test("quick reply rendering reports missing and unsupported variables without leaking a partial send",()=>{
  const rendered=renderQuickReplyVariables("Hi {{first_name}} {{email}} {{company}}",{...values,email:""});
  assert.deepEqual(rendered.missing,["email"]);
  assert.deepEqual(rendered.unsupported,["company"]);
  assert.match(rendered.text,/{{email}}/);
  assert.match(rendered.text,/{{company}}/);
});
