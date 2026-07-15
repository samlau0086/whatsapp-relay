import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
await mkdir(new URL("../dist/renderer/", import.meta.url), { recursive:true });
const packageJson=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8"));
const renderer=await readFile(new URL("../src/renderer/index.html",import.meta.url),"utf8");
await writeFile(new URL("../dist/renderer/index.html",import.meta.url),renderer.replaceAll("__AGENT_VERSION__",packageJson.version));
await cp(new URL("../src/preload.cjs", import.meta.url), new URL("../dist/preload.cjs", import.meta.url));
