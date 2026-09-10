const API_URL = (process.env.NEXT_PUBLIC_RELAY_API_URL ?? "").replace(/\/$/, "");
const REMEMBER_LOGIN_KEY = "relayRememberLogin";

let refreshPromise: Promise<string> | null = null;
let currentAccessToken = "";

export type AuthorizedFetchResult = { response: Response; token: string };

export function setCurrentAccessToken(token: string) { currentAccessToken = token; }

export function storeSession(token: string, user: unknown, rememberMe: boolean) {
  currentAccessToken = token;
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
  const firstToken = currentAccessToken || token;
  let response = await send(firstToken);
  if (response.status !== 401) return { response, token: firstToken };
  if (currentAccessToken && currentAccessToken !== firstToken) {
    response = await send(currentAccessToken);
    if (response.status !== 401) return { response, token: currentAccessToken };
  }
  const refreshedToken = await refreshAccessTokenOnce();
  if (!refreshedToken) return { response, token };
  currentAccessToken = refreshedToken;
  const storage = localStorage.getItem(REMEMBER_LOGIN_KEY) === "true" ? localStorage : sessionStorage;
  storage.setItem("relayAccessToken", refreshedToken);
  response = await send(refreshedToken);
  return { response, token: refreshedToken };
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
