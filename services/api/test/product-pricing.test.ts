import assert from "node:assert/strict";
import test from "node:test";
import { productPriceTierSchema } from "../src/schemas.js";

test("product price uses gross margin rather than cost markup",()=>{
  assert.equal(productPriceTierSchema.safeParse({minQuantity:1,costAmount:80,profitMargin:20,unitAmount:100}).success,true);
  assert.equal(productPriceTierSchema.safeParse({minQuantity:1,costAmount:80,profitMargin:20,unitAmount:96}).success,false);
  assert.equal(productPriceTierSchema.safeParse({minQuantity:1,costAmount:80,profitMargin:100,unitAmount:80}).success,false);
});
