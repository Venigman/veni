import type { APITab } from "./storage";

export interface RunInput {
  api: APITab;
  method: string;
  path: string;
  headers: Array<{ key: string; value: string }>;
  query: Array<{ key: string; value: string }>;
  body?: string;
  /** If set, ignore `body` and send multipart/form-data with `file` field. */
  file?: File;
}

export interface RunResult {
  status: number;
  statusText: string;
  ok: boolean;
  durationMs: number;
  contentType: string;
  size: number;
  data: unknown;
  rawText: string;
  responseHeaders: Record<string, string>;
  /** Display URL — auth query param stripped to avoid token leakage in UI / history. */
  displayURL: string;
  /** Path использованный в запросе (без query) — нужен File Browser'у для навигации. */
  requestPath: string;
  error?: string;
}

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ABSOLUTE_URL = /^https?:\/\//i;

export function buildURL(api: APITab, path: string, query: RunInput["query"]) {
  const trimmedPath = path.trim();
  const base = (api.baseURL || "").replace(/\/+$/, "");

  let url: URL;
  if (ABSOLUTE_URL.test(trimmedPath)) {
    url = new URL(trimmedPath);
  } else {
    const rel = trimmedPath.startsWith("/")
      ? trimmedPath
      : trimmedPath
        ? `/${trimmedPath}`
        : "";
    url = new URL(`${base}${rel}`);
  }

  for (const { key, value } of query) {
    if (key) url.searchParams.set(key, value);
  }
  if (api.auth.kind === "query" && api.auth.queryName && api.auth.token) {
    url.searchParams.set(api.auth.queryName, api.auth.token);
  }
  return url;
}

/** Returns a URL string safe to display/log — auth query token replaced with "•••". */
function sanitizeURL(url: URL, api: APITab): string {
  if (api.auth.kind !== "query" || !api.auth.queryName) return url.toString();
  const display = new URL(url.toString());
  if (display.searchParams.has(api.auth.queryName)) {
    display.searchParams.set(api.auth.queryName, "•••");
  }
  return display.toString();
}

export async function runRequest(input: RunInput): Promise<RunResult> {
  const { api, method, path, headers, query, body, file } = input;

  const url = buildURL(api, path, query);
  const displayURL = sanitizeURL(url, api);

  const reqHeaders = new Headers();
  for (const h of api.defaultHeaders) {
    if (h.key) reqHeaders.set(h.key, h.value);
  }
  for (const h of headers) {
    if (h.key) reqHeaders.set(h.key, h.value);
  }
  if (api.auth.kind === "bearer" && api.auth.token) {
    reqHeaders.set("Authorization", `Bearer ${api.auth.token}`);
  }
  if (api.auth.kind === "header" && api.auth.headerName && api.auth.token) {
    reqHeaders.set(api.auth.headerName, api.auth.token);
  }

  const init: RequestInit = {
    method: method.toUpperCase(),
    headers: reqHeaders,
    // Avoid leaking the full URL (with query-auth tokens) in Referer header
    referrerPolicy: "no-referrer",
  };

  if (file) {
    // multipart: browser сам выставит правильный Content-Type c boundary
    const fd = new FormData();
    fd.append("file", file, file.name);
    // Если в body есть JSON — добавим его поля как form fields (для команд типа face match)
    if (body && body.trim()) {
      try {
        const obj = JSON.parse(body) as Record<string, unknown>;
        for (const [k, v] of Object.entries(obj)) {
          if (v !== undefined && v !== null) fd.append(k, String(v));
        }
      } catch {
        /* not JSON — ignore body when file is set */
      }
    }
    init.body = fd;
    reqHeaders.delete("content-type"); // позволим браузеру выставить multipart boundary
  } else if (METHODS_WITH_BODY.has(method.toUpperCase()) && body && body.trim()) {
    init.body = body;
    if (!reqHeaders.has("content-type")) {
      try {
        JSON.parse(body);
        reqHeaders.set("Content-Type", "application/json");
      } catch {
        reqHeaders.set("Content-Type", "text/plain");
      }
    }
  }

  const t0 = performance.now();
  try {
    const res = await fetch(url.toString(), init);
    const rawText = await res.text();
    const durationMs = Math.round(performance.now() - t0);

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const contentType = responseHeaders["content-type"] ?? "";
    let data: unknown = rawText;
    if (contentType.includes("json") || (rawText && /^[\[{]/.test(rawText.trim()))) {
      try {
        data = JSON.parse(rawText);
      } catch {
        // keep raw text
      }
    }

    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      durationMs,
      contentType,
      size: rawText.length,
      data,
      rawText,
      responseHeaders,
      displayURL,
      requestPath: path.split("?")[0] || path,
    };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - t0);
    const message =
      err instanceof Error ? err.message : "Network error or CORS blocked";
    return {
      status: 0,
      statusText: "Network Error",
      ok: false,
      durationMs,
      contentType: "",
      size: 0,
      data: null,
      rawText: message,
      responseHeaders: {},
      displayURL,
      requestPath: path.split("?")[0] || path,
      error: message,
    };
  }
}
