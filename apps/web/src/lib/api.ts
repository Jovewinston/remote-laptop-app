import {
  DEFAULT_BAY_API_URL,
  DEFAULT_BAY_DOWNLOAD_CONNECT_URL,
  DEFAULT_BAY_DOWNLOAD_HOST_URL,
} from "@bay/shared";

/** Local Next defaults to local API; Railway sets NEXT_PUBLIC_BAY_API at build. */
const API =
  process.env.NEXT_PUBLIC_BAY_API ??
  (process.env.NODE_ENV === "production"
    ? DEFAULT_BAY_API_URL
    : "http://127.0.0.1:8788");

export function bayApiBaseUrl() {
  return API;
}

export function bayDownloadHostUrl() {
  return process.env.NEXT_PUBLIC_BAY_DOWNLOAD_HOST ?? DEFAULT_BAY_DOWNLOAD_HOST_URL;
}

export function bayDownloadConnectUrl() {
  return (
    process.env.NEXT_PUBLIC_BAY_DOWNLOAD_CONNECT ??
    DEFAULT_BAY_DOWNLOAD_CONNECT_URL
  );
}

export function getToken() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("bay_token");
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) localStorage.setItem("bay_token", token);
  else localStorage.removeItem("bay_token");
}

export async function api<T>(
  path: string,
  opts: RequestInit & { auth?: boolean } = {}
): Promise<T> {
  const headers = new Headers(opts.headers);
  if (!headers.has("Content-Type") && opts.body) {
    headers.set("Content-Type", "application/json");
  }
  if (opts.auth !== false) {
    const token = getToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export { API };
