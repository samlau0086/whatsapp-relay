import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";

test("Windows Agent releases do not duplicate installers in workflow artifact storage",async()=>{
  const workflow=await readFile(new URL("../../../.github/workflows/agent-release.yml",import.meta.url),"utf8");
  assert.doesNotMatch(workflow,/actions\/upload-artifact/);
  assert.match(workflow,/gh release (?:upload|create)/);
});

test("performance diagnostics cannot block deployment when artifact storage is full",async()=>{
  const workflow=await readFile(new URL("../../../.github/workflows/deploy-vps.yml",import.meta.url),"utf8");
  const upload=workflow.slice(workflow.indexOf("- name: Upload performance artifacts"),workflow.indexOf("- name: Stop isolated performance stack"));
  assert.match(upload,/continue-on-error: true/);
  assert.match(upload,/if-no-files-found: ignore/);
  assert.match(upload,/retention-days: 3/);
});
