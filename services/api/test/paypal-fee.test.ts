import assert from "node:assert/strict";
import test from "node:test";
import { calculatePayPalFee } from "../src/paypal-fee.js";

test("PayPal fee follows P=(N+F)/(1-r)-N and rounds gross payment up to cents",()=>{
  assert.equal(calculatePayPalFee(100,4.4,.3),4.92);
  assert.equal(calculatePayPalFee(10,0,0.3),0.3);
  assert.equal(calculatePayPalFee(100,0,0),0);
});
