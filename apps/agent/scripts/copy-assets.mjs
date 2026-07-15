import { cp, mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/renderer/", import.meta.url), { recursive:true });
await cp(new URL("../src/renderer/index.html", import.meta.url), new URL("../dist/renderer/index.html", import.meta.url));
await cp(new URL("../src/preload.cjs", import.meta.url), new URL("../dist/preload.cjs", import.meta.url));
