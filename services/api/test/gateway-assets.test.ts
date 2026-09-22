import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("gateway buffers immutable assets without websocket upgrade headers",async()=>{
  const config=await readFile(new URL("../../../infra/nginx/default.conf",import.meta.url),"utf8");
  const assets=config.match(/location \^~ \/assets\/ \{[\s\S]*?\n    \}/)?.[0]??"";
  assert.match(assets,/proxy_buffering on/);
  assert.match(assets,/Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(assets,/proxy_set_header Upgrade ""/);
  assert.match(assets,/proxy_set_header Connection ""/);
  assert.match(assets,/add_header X-Content-Type-Options "nosniff" always/);
  assert.match(assets,/add_header X-Frame-Options "DENY" always/);
  assert.match(assets,/add_header Referrer-Policy "no-referrer" always/);
});
