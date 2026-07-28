export const IMMUTABLE_PRIVATE_CACHE_CONTROL = "private, max-age=31536000, immutable";

export function strongEtag(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function ifNoneMatchMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const values = Array.isArray(header) ? header : header.split(",");
  const opaqueEtag = etag.replace(/^W\//, "");
  return values.some(value => {
    const candidate = value.trim();
    return candidate === "*" || candidate.replace(/^W\//, "") === opaqueEtag;
  });
}
