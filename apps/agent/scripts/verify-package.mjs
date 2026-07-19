import { extractAll } from "@electron/asar";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const archive=fileURLToPath(new URL("../release/win-unpacked/resources/app.asar",import.meta.url));
const expected=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
const directory=await mkdtemp(join(tmpdir(),"relaydesk-package-"));
extractAll(archive,directory);
const packaged=JSON.parse(await readFile(join(directory,"package.json"),"utf8"));
const renderer=await readFile(join(directory,"dist","renderer","index.html"),"utf8");
const main=await readFile(join(directory,"dist","main.js"),"utf8");
const preload=await readFile(join(directory,"dist","preload.cjs"),"utf8");
const worker=await readFile(new URL("../release/win-unpacked/resources/app.asar.unpacked/dist/account-worker.js",import.meta.url),"utf8");

if(packaged.version!==expected.version)throw new Error(`Packaged version ${packaged.version} does not match ${expected.version}`);
for(const marker of [`v${expected.version}`,"build-version","proxy-mode","updateAccount","central-settings-card","updateCentralUrl"]){
  if(!renderer.includes(marker))throw new Error(`Packaged renderer is missing ${marker}`);
}
if(renderer.includes("__AGENT_VERSION__"))throw new Error("Agent version placeholder was not replaced");
if(!main.includes("@relaydesk")||!main.includes("windows-agent"))throw new Error("Stable user data path is missing");
if(!main.includes("agent:update-central-url"))throw new Error("Packaged main process is missing central URL updates");
if(!preload.includes("agent:state")||!preload.includes("account:add")||!preload.includes("updateCentralUrl"))throw new Error("Packaged preload bridge is incomplete");
for(const marker of ["downloadOutboundMedia","AbortSignal.timeout(12_000)","send_deferred_after_transient_error"]){
  if(!worker.includes(marker))throw new Error(`Packaged account worker is missing ${marker}`);
}
await rm(directory,{recursive:true,force:true});
console.log(`Verified RelayDesk Agent v${expected.version} packaged renderer, preload and persistent data path.`);
