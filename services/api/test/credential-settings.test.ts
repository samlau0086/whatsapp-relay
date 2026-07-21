import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin credential settings reload decrypted values without caching or logging request secrets",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  const ui=await readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
  for(const route of ["paypal-settings","translation-providers","tts-providers","agent-provider"]){
    const routeIndex=server.indexOf(`app.get("/api/v1/admin/${route}`);
    assert.notEqual(routeIndex,-1,`${route} admin GET route must exist`);
    const routeSource=server.slice(routeIndex,routeIndex+1800);
    assert.match(routeSource,/role!=="admin"/);
    assert.match(routeSource,/cache-control","no-store"/);
    assert.match(routeSource,/decryptAtRest/);
  }
  assert.match(server,/"req.body.apiKey","req.body.clientId","req.body.clientSecret"/);
  assert.match(ui,/function SecretField/);
  assert.match(ui,/navigator\.clipboard\?\.writeText/);
  assert.match(ui,/<EyeOff size=\{16\}\/>:<Eye size=\{16\}\/>/);
  assert.match(ui,/setClientId\(String\(body\.clientId/);
  assert.match(ui,/value=\{current\.apiKey\}/);
  assert.match(ui,/value=\{provider\.api_key\}/);
});
