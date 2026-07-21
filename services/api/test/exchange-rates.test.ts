import assert from "node:assert/strict";
import test from "node:test";
import { fetchLatestExchangeRates } from "../src/exchange-rates.js";

test("loads and validates latest rates for configured currencies",async()=>{
  const fetcher:typeof fetch=async input=>{const url=new URL(String(input));assert.equal(url.searchParams.get("base"),"USD");assert.equal(url.searchParams.get("quotes"),"CNY,EUR");return new Response(JSON.stringify([{date:"2026-07-20",base:"USD",quote:"CNY",rate:7.18},{date:"2026-07-20",base:"USD",quote:"EUR",rate:.86}]),{status:200,headers:{"content-type":"application/json"}});};
  assert.deepEqual(await fetchLatestExchangeRates("usd",["USD","CNY","EUR","CNY"],fetcher),{date:"2026-07-20",rates:{USD:1,CNY:7.18,EUR:.86}});
});

test("rejects partial rate responses instead of silently retaining stale values",async()=>{
  const fetcher:typeof fetch=async()=>new Response(JSON.stringify([{date:"2026-07-20",base:"USD",quote:"EUR",rate:.86}]),{status:200});
  await assert.rejects(fetchLatestExchangeRates("USD",["USD","EUR","AED"],fetcher),/AED/);
});

test("surfaces upstream API errors",async()=>{
  const fetcher:typeof fetch=async()=>new Response(JSON.stringify({message:"Could not find currency ABC"}),{status:422});
  await assert.rejects(fetchLatestExchangeRates("USD",["USD","ABC"],fetcher),/Could not find currency ABC/);
});
