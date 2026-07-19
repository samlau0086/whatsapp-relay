import assert from "node:assert/strict";
import test from "node:test";
import { calculateOrderTotal, canManageSharedRecord, formatOrderSummary, preferredCustomerStage } from "../src/crm.js";

test("shared notes remain owner-managed with supervisor override",()=>{
  assert.equal(canManageSharedRecord("agent","user-1","user-1"),true);
  assert.equal(canManageSharedRecord("agent","user-1","user-2"),false);
  assert.equal(canManageSharedRecord("supervisor","user-1","user-2"),true);
  assert.equal(canManageSharedRecord("admin",null,"user-2"),true);
});

test("contact merges retain the furthest customer stage",()=>{
  assert.equal(preferredCustomerStage("new","qualified"),"qualified");
  assert.equal(preferredCustomerStage("won","lost"),"won");
});

test("order summaries are stable and customer-readable",()=>{
  const items=[{name:"Perfume",quantity:2,unitAmount:49.75},{name:"Gift box",quantity:1,unitAmount:8}];
  const fees=[{name:"Shipping",amount:6.5}];
  assert.equal(calculateOrderTotal(items,fees),114);
  const summary=formatOrderSummary(27,items,fees,"USD","Handle with care");
  assert.match(summary,/Order #000027/);
  assert.match(summary,/1\. Perfume x 2 - USD 49\.75 each - USD 99\.50/);
  assert.match(summary,/Additional fees:\nShipping - USD 6\.50/);
  assert.match(summary,/Total: USD 114\.00/);
  assert.match(summary,/Notes: Handle with care/);
});
