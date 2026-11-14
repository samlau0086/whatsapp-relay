import {test} from "node:test";
import {strict as assert} from "node:assert";
import {normalizeLivechatOrigins} from "../src/livechat.js";

test("LiveChat origins are normalized and deduplicated",()=>{
  assert.deepEqual(normalizeLivechatOrigins(["https://EXAMPLE.com:443/","https://example.com","http://localhost:3000"]),["https://example.com","http://localhost:3000"]);
});

test("LiveChat origins reject insecure and non-origin URLs",()=>{
  for(const origin of ["http://example.com","https://example.com/path","https://example.com/?x=1","https://user@example.com","javascript:alert(1)","*"]){
    assert.throws(()=>normalizeLivechatOrigins([origin]));
  }
});
