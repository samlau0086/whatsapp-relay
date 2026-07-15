import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentStore } from "../dist/store.js";

test("removed-account status cleanup never skips a message event", () => {
  const directory=mkdtempSync(join(tmpdir(),"relaydesk-store-"));
  const store=new AgentStore(join(directory,"agent.db"));
  try {
    store.upsertAccount("current","Current account","online");
    store.enqueueEvent("status-removed","account_status",{accountId:"removed",status:"offline"});
    store.enqueueEvent("status-current","account_status",{accountId:"current",status:"online"});
    store.enqueueEvent("message-removed","message",{accountId:"removed",messageId:"message-1"});

    assert.equal(store.discardRemovedAccountStatusEvents(),1);
    assert.deepEqual(store.pendingEvents().map(event=>event.event_id),["status-current","message-removed"]);

    store.deleteAccount("current");
    assert.equal(store.discardRemovedAccountStatusEvents(),1);
    assert.deepEqual(store.pendingEvents().map(event=>event.event_id),["message-removed"]);
    assert.equal(store.diagnostics().lastAckedCursor,2);
  } finally {
    store.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
