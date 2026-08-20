import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const API_URL = "https://api.github.com/repos/samlau0086/whatsapp-relay/releases";
const USER_AGENT = "RelayDesk-Agent";
type Asset = { name?: string; browser_download_url?: string };
type Release = { tag_name?: string; html_url?: string; body?: string; published_at?: string; assets?: Asset[] };
export type AgentUpdate = { currentVersion: string; latestVersion: string | null; updateAvailable: boolean; releaseUrl: string | null; notes: string | null; publishedAt: string | null; installerUrl: string | null; checksumUrl: string | null; checkedAt: string; error?: string };

function version(value: string): number[] { const match=value.match(/(\d+)\.(\d+)\.(\d+)/); return match?[Number(match[1]),Number(match[2]),Number(match[3])]:[0,0,0]; }
function newer(left: string, right: string): boolean { const a=version(left),b=version(right); return a[0]>b[0]||(a[0]===b[0]&&(a[1]>b[1]||(a[1]===b[1]&&a[2]>b[2]))); }
function headers(): HeadersInit { return { accept: "application/vnd.github+json", "user-agent": USER_AGENT }; }

export async function checkAgentUpdate(currentVersion: string): Promise<AgentUpdate> {
  const checkedAt=new Date().toISOString();
  try {
    const response=await fetch(`${API_URL}?per_page=30`,{headers:headers(),signal:AbortSignal.timeout(15_000)});
    if(!response.ok)throw new Error(`GitHub HTTP ${response.status}`);
    const releases=await response.json() as Release[];
    const candidates=releases.filter(item=>/^agent-v\d+\.\d+\.\d+$/.test(item.tag_name??""));
    const release=candidates.sort((a,b)=>newer((b.tag_name??"").slice(7),(a.tag_name??"").slice(7))?1:-1)[0];
    if(!release?.tag_name)return {currentVersion,latestVersion:null,updateAvailable:false,releaseUrl:null,notes:null,publishedAt:null,installerUrl:null,checksumUrl:null,checkedAt,error:"未找到 Agent 发布版本"};
    const latestVersion=release.tag_name.slice(7);
    const assets=release.assets??[];
    const installer=assets.find(item=>item.name===`RelayDesk-Agent-${latestVersion}-x64.exe`);
    const checksum=assets.find(item=>item.name==="SHA256SUMS.txt");
    return {currentVersion,latestVersion,updateAvailable:newer(latestVersion,currentVersion),releaseUrl:release.html_url??null,notes:release.body?.trim()||null,publishedAt:release.published_at??null,installerUrl:installer?.browser_download_url??null,checksumUrl:checksum?.browser_download_url??null,checkedAt};
  } catch(error) { return {currentVersion,latestVersion:null,updateAvailable:false,releaseUrl:null,notes:null,publishedAt:null,installerUrl:null,checksumUrl:null,checkedAt,error:error instanceof Error?error.message:String(error)}; }
}

export async function downloadAndInstallAgentUpdate(update: AgentUpdate): Promise<{version:string}> {
  if(!update.updateAvailable||!update.latestVersion||!update.installerUrl||!update.checksumUrl)throw new Error("该版本没有可用的官方安装包");
  if(!/^https:\/\/github\.com\/samlau0086\/whatsapp-relay\/releases\/download\//.test(update.installerUrl))throw new Error("安装包地址无效");
  const directory=join(tmpdir(),"relaydesk-agent-update"); await mkdir(directory,{recursive:true});
  const installerPath=join(directory,`RelayDesk-Agent-${update.latestVersion}-x64.exe`);
  const installerResponse=await fetch(update.installerUrl,{headers:headers(),redirect:"follow",signal:AbortSignal.timeout(180_000)});
  if(!installerResponse.ok||!installerResponse.body)throw new Error(`下载安装包失败（HTTP ${installerResponse.status}）`);
  await pipeline(installerResponse.body as unknown as NodeJS.ReadableStream,createWriteStream(installerPath));
  const checksumResponse=await fetch(update.checksumUrl,{headers:headers(),redirect:"follow",signal:AbortSignal.timeout(30_000)});
  if(!checksumResponse.ok)throw new Error("无法下载安装包校验文件");
  const sums=await checksumResponse.text(); const expected=sums.split(/\r?\n/).find(line=>line.includes(`RelayDesk-Agent-${update.latestVersion}-x64.exe`))?.trim().split(/\s+/)[0]?.toLowerCase();
  if(!expected)throw new Error("校验文件中没有对应安装包");
  const actual=createHash("sha256").update(await readFile(installerPath)).digest("hex");
  if(actual!==expected)throw new Error("安装包校验失败，已停止安装");
  const child=spawn(installerPath,["/S"],{detached:true,stdio:"ignore",windowsHide:true}); child.unref();
  setTimeout(()=>void rm(directory,{recursive:true,force:true}),60_000);
  return {version:update.latestVersion};
}
