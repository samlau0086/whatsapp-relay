import { readFile } from "node:fs/promises";

export type BaileysUpdate = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  publishedAt: string | null;
  notes: string | null;
  checkedAt: string;
  error?: string;
};

const PACKAGE_URL = "https://registry.npmjs.org/@whiskeysockets%2fbaileys/latest";
const RELEASES_URL = "https://api.github.com/repos/WhiskeySockets/Baileys/releases";

function versionParts(value: string): number[] {
  const match = value.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : [0, 0, 0];
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left), b = versionParts(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return left === right ? 0 : left.includes("rc") ? -1 : 1;
}

export async function checkBaileysUpdate(currentVersion: string): Promise<BaileysUpdate> {
  const checkedAt = new Date().toISOString();
  try {
    const packageResponse = await fetch(PACKAGE_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!packageResponse.ok) throw new Error(`npm registry HTTP ${packageResponse.status}`);
    const packageData = await packageResponse.json() as { version?: string };
    const latestVersion = typeof packageData.version === "string" ? packageData.version : null;
    if (!latestVersion) throw new Error("npm registry returned no version");

    let releaseUrl: string | null = `https://github.com/WhiskeySockets/Baileys/releases`;
    let publishedAt: string | null = null;
    let notes: string | null = null;
    const releasesResponse = await fetch(`${RELEASES_URL}?per_page=10`, { headers: { accept: "application/vnd.github+json", "user-agent": "RelayDesk-Agent" }, signal: AbortSignal.timeout(15_000) });
    if (releasesResponse.ok) {
      const releases = await releasesResponse.json() as Array<{ tag_name?: string; html_url?: string; published_at?: string; body?: string }>;
      const match = releases.find(item => item.tag_name?.replace(/^v/, "") === latestVersion);
      if (match) { releaseUrl = match.html_url ?? releaseUrl; publishedAt = match.published_at ?? null; notes = match.body?.trim() || null; }
    }
    return { currentVersion, latestVersion, updateAvailable: compareVersions(currentVersion, latestVersion) < 0, releaseUrl, publishedAt, notes, checkedAt };
  } catch (error) {
    return { currentVersion, latestVersion: null, updateAvailable: false, releaseUrl: null, publishedAt: null, notes: null, checkedAt, error: error instanceof Error ? error.message : String(error) };
  }
}
