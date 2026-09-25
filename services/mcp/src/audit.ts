export type AuditEntry = { tool: string; accountId: string | null; requestId: string; ok: boolean; durationMs: number; resultCount?: number; errorCode?: string };

export function audit(entry: AuditEntry): void {
  // stderr is intentionally used so stdout remains a clean MCP stdio channel.
  process.stderr.write(`${JSON.stringify({ type: "mcp.audit", at: new Date().toISOString(), ...entry })}\n`);
}
