import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("conversation transfer preserves conversation-owned records and original message provenance",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/app\.post\("\/api\/v1\/conversations\/:id\/transfer"/);
  assert.match(server,/UPDATE contacts SET account_id=\$2/);
  assert.match(server,/UPDATE conversations SET account_id=\$2/);
  assert.match(server,/UPDATE tasks SET account_id=\$2/);
  assert.doesNotMatch(server,/UPDATE messages SET account_id=.*transfer/);
  assert.match(server,/conversation\.transfer/);
});

test("conversation account transfer is explicitly confirmed in the inbox",async()=>{
  const inbox=await readFile(new URL("../../../app/whatsapp-inbox.tsx",import.meta.url),"utf8");
  assert.match(inbox,/确认转移账号？/);
  assert.match(inbox,/聊天记录、标签、备注、订单及其他会话关联信息都会保留/);
  assert.match(inbox,/\/api\/v1\/conversations\/\$\{conversation\.id\}\/transfer/);
});
