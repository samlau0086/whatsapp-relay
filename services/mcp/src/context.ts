export type McpContext = {
  apiBaseUrl: string;
  apiKey: string;
  accountId: string | null;
  writeScopes: ReadonlySet<WriteScope>;
};

export const WRITE_SCOPES = ["messages:send", "conversations:write", "contacts:write"] as const;
export type WriteScope = typeof WRITE_SCOPES[number];

export function loadContext(env: NodeJS.ProcessEnv = process.env): McpContext {
  const apiBaseUrl = String(env.RELAY_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
  const apiKey = String(env.RELAY_API_KEY ?? "").trim();
  const accountScope = String(env.RELAY_ACCOUNT_ID ?? "").trim();
  if (!apiKey) throw new Error("RELAY_API_KEY is required");
  if (!accountScope) throw new Error("RELAY_ACCOUNT_ID is required; use 'all' for all permitted accounts");
  const accountId = accountScope.toLowerCase() === "all" ? null : accountScope;
  const requestedScopes = String(env.RELAY_MCP_WRITE_SCOPES ?? "").split(",").map(scope => scope.trim()).filter(Boolean);
  if (requestedScopes.some(scope => !WRITE_SCOPES.includes(scope as WriteScope))) throw new Error("RELAY_MCP_WRITE_SCOPES contains an unsupported scope");
  try { new URL(apiBaseUrl); } catch { throw new Error("RELAY_API_BASE_URL must be a valid URL"); }
  return { apiBaseUrl, apiKey, accountId, writeScopes: new Set(requestedScopes as WriteScope[]) };
}
