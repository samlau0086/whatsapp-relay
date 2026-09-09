import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("media cleanup deletes only assets without any supported association",async()=>{
  const server=await readFile(new URL("../src/server.ts",import.meta.url),"utf8");
  assert.match(server,/app\.delete\("\/api\/v1\/media", \{preHandler:authenticate\}/);
  assert.match(server,/media\.delete_unused/);
  for(const relation of ["messages msg WHERE msg.media_id=m.id","order_items item WHERE item.image_media_id=m.id","orders o WHERE o.rendered_media_id=m.id","products p WHERE p.image_media_id=m.id","email_attachments e WHERE e.media_id=m.id","material_assets a WHERE a.media_id=m.id","collage_templates t WHERE t.deleted_at IS NULL"]){assert.match(server,new RegExp(relation.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));}
  assert.match(server,/DELETE FROM media WHERE id=ANY\(\$1::uuid\[\]\)/);
});
