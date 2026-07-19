import assert from "node:assert/strict";
import test from "node:test";
import { canManageSharedRecord, formatOrderSummary, preferredCustomerStage } from "../src/crm.js";

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
  assert.equal(formatOrderSummary(27,"香水",99.5,"USD","含运费"),"订单 #000027\n商品：香水\n金额：USD 99.50\n说明：含运费");
  assert.match(formatOrderSummary(1,undefined,10,"CNY"),/手工订单/);
});
