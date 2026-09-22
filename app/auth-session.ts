const API_URL = (process.env.NEXT_PUBLIC_RELAY_API_URL ?? "").replace(/\/$/, "");
const REMEMBER_LOGIN_KEY = "relayRememberLogin";
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 60_000;

export const SESSION_EXPIRED_EVENT = "relay-session-expired";

let refreshPromise: Promise<string> | null = null;
let currentAccessToken = "";
let sessionExpiredNotified = false;

export type AuthorizedFetchResult = { response: Response; token: string };

export function setCurrentAccessToken(token: string) {
  currentAccessToken = token;
  if (token) sessionExpiredNotified = false;
}

export function storeSession(token: string, user: unknown, rememberMe: boolean) {
  currentAccessToken = token;
  sessionExpiredNotified = false;
  clearStoredSession();
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem("relayAccessToken", token);
  storage.setItem("relayUser", JSON.stringify(user));
  if (rememberMe) localStorage.setItem(REMEMBER_LOGIN_KEY, "true");
}

export function clearStoredSession() {
  currentAccessToken = "";
  for (const storage of [localStorage, sessionStorage]) {
    storage.removeItem("relayAccessToken");
    storage.removeItem("relayUser");
  }
  localStorage.removeItem(REMEMBER_LOGIN_KEY);
}

export async function authorizedFetch(path: string, token: string, init: RequestInit = {}): Promise<AuthorizedFetchResult> {
  const send = (accessToken: string) => fetch(API_URL + path, {
    ...init,
    credentials: "include",
    headers: { ...init.headers, authorization: "Bearer " + accessToken },
  });
  let firstToken = currentAccessToken || token;
  const expiresAt = accessTokenExpiresAt(firstToken);
  if (expiresAt !== null && expiresAt <= Date.now() + ACCESS_TOKEN_REFRESH_WINDOW_MS) {
    const refreshedToken = await refreshAccessTokenOnce();
    if (refreshedToken) {
      persistRefreshedAccessToken(refreshedToken);
      firstToken = refreshedToken;
    } else if (expiresAt <= Date.now()) {
      notifySessionExpired();
      return { response: sessionExpiredResponse(), token: firstToken };
    }
  }
  let response = await send(firstToken);
  if (response.status !== 401) return { response, token: firstToken };
  if (currentAccessToken && currentAccessToken !== firstToken) {
    response = await send(currentAccessToken);
    if (response.status !== 401) return { response, token: currentAccessToken };
  }
  const refreshedToken = await refreshAccessTokenOnce();
  if (!refreshedToken) {
    notifySessionExpired();
    return { response, token };
  }
  persistRefreshedAccessToken(refreshedToken);
  response = await send(refreshedToken);
  if (response.status === 401) notifySessionExpired();
  return { response, token: refreshedToken };
}

function accessTokenExpiresAt(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const expiresAt = Number((JSON.parse(atob(normalized)) as { exp?: unknown }).exp);
    return Number.isFinite(expiresAt) ? expiresAt * 1000 : null;
  } catch {
    return null;
  }
}

function persistRefreshedAccessToken(token: string) {
  currentAccessToken = token;
  sessionExpiredNotified = false;
  const storage = localStorage.getItem(REMEMBER_LOGIN_KEY) === "true" ? localStorage : sessionStorage;
  storage.setItem("relayAccessToken", token);
}

function notifySessionExpired() {
  if (sessionExpiredNotified) return;
  sessionExpiredNotified = true;
  clearStoredSession();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

function sessionExpiredResponse() {
  return new Response(JSON.stringify({ error: "session_expired" }), { status: 401, headers: { "content-type": "application/json" } });
}

function refreshAccessTokenOnce() {
  if (!refreshPromise) refreshPromise = refreshAccessToken().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function refreshAccessToken() {
  const response = await fetch(API_URL + "/api/v1/auth/refresh", { method: "POST", credentials: "include" });
  if (!response.ok) return "";
  const body = await response.json() as { accessToken?: string };
  return body.accessToken ?? "";
}
