import assert from "node:assert/strict";
import test from "node:test";
import { orderSchema, productCreateSchema } from "../src/schemas.js";
import { calculateOrderWeight, convertWeight } from "../src/weight.js";

const id="10000000-0000-4000-8000-000000000001";

test("weight conversion uses exact metric and imperial factors",()=>{
  assert.equal(convertWeight(1,"kg","g"),1000);
  assert.ok(Math.abs(convertWeight(1,"lbs","oz")-16)<1e-12);
  assert.ok(Math.abs(convertWeight(16,"oz","lbs")-1)<1e-12);
});

test("order weight sums quantities in the selected target unit",()=>{
  const total=calculateOrderWeight([
    {quantity:2,weightAmount:500,weightUnit:"g"},
    {quantity:1,weightAmount:1,weightUnit:"lbs"},
    {quantity:3},
  ],"kg");
  assert.ok(Math.abs(total-1.45359237)<1e-12);
});

test("product and order schemas require complete valid weight pairs",()=>{
  const product={clientProductId:id,name:"Bag",sku:"BAG-1",priceTiers:[{minQuantity:1,unitAmount:10}],currency:"USD",weightAmount:500,weightUnit:"g"};
  assert.equal(productCreateSchema.safeParse(product).success,true);
  assert.equal(productCreateSchema.safeParse({...product,weightUnit:undefined}).success,false);
  assert.equal(productCreateSchema.safeParse({...product,weightUnit:"stone"}).success,false);

  const order={clientOrderId:id,currency:"USD",weightUnit:"lbs",items:[{name:"Bag",quantity:2,unitAmount:10,weightAmount:500,weightUnit:"g"}]};
  assert.equal(orderSchema.safeParse(order).success,true);
  assert.equal(orderSchema.safeParse({...order,weightUnit:"stone"}).success,false);
  assert.equal(orderSchema.safeParse({...order,items:[{name:"Bag",quantity:2,unitAmount:10,weightAmount:500}]}).success,false);
});
