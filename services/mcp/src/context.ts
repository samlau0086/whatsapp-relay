export type McpContext = {
  apiBaseUrl: string;
  apiKey: string;
  accountId: string | null;
};

export function loadContext(env: NodeJS.ProcessEnv = process.env): McpContext {
  const apiBaseUrl = String(env.RELAY_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const apiKey = String(env.RELAY_API_KEY ?? "").trim();
  const accountScope = String(env.RELAY_ACCOUNT_ID ?? "").trim();
  if (!apiKey) throw new Error("RELAY_API_KEY is required");
  if (!accountScope) throw new Error("RELAY_ACCOUNT_ID is required; use 'all' for all permitted accounts");
  const accountId = accountScope.toLowerCase() === "all" ? null : accountScope;
  try { new URL(apiBaseUrl); } catch { throw new Error("RELAY_API_BASE_URL must be a valid URL"); }
  return { apiBaseUrl, apiKey, accountId };
}
