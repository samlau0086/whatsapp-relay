import type { McpContext } from "./context.js";

export class RelayApiError extends Error {
  constructor(public readonly code: string, public readonly status: number, message?: string) {
    super(message ?? code);
    this.name = "RelayApiError";
  }
}

export class RelayApiClient {
  constructor(private readonly context: McpContext, private readonly fetchImpl: typeof fetch = fetch) {}

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`/api/v1${path}`, `${this.context.apiBaseUrl}/`);
    if (this.context.accountId) url.searchParams.set("accountId", this.context.accountId);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${this.context.apiKey}`, accept: "application/json" }, signal: controller.signal });
      const text = await response.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!response.ok) {
        const code = response.status === 401 ? "unauthorized" : response.status === 403 ? "account_forbidden" : response.status === 404 ? "not_found" : response.status === 429 ? "rate_limited" : response.status >= 500 ? "upstream_unavailable" : "invalid_argument";
        throw new RelayApiError(code, response.status, `Relay API returned HTTP ${response.status}`);
      }
      if (body === null || typeof body !== "object") throw new RelayApiError("upstream_unavailable", 502, "Relay API returned a non-JSON response; check RELAY_API_BASE_URL");
      return body as T;
    } catch (error) {
      if (error instanceof RelayApiError) throw error;
      throw new RelayApiError("upstream_unavailable", 503, error instanceof Error && error.name === "AbortError" ? "Relay API timeout; check RELAY_API_BASE_URL" : "Cannot connect to Relay API; check RELAY_API_BASE_URL and network access");
    } finally { clearTimeout(timeout); }
  }
}
