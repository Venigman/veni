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
  /**
   * Если задано — фоновое обновление промежуточных результатов во время
   * SSE-стрима. Вызывается на каждом событии (start/hit/progress/done).
   * Тело RunResult формируется накоплением hit'ов и финализируется
   * по событию `done`. Если функция не задана — стрим режется в RunResult
   * только в конце.
   */
  onStreamEvent?: (ev: StreamEvent, snapshot: RunResult) => void;
  /** AbortSignal для отмены стрима кнопкой Stop. */
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "start"; username: string; total: number }
  | {
      type: "hit";
      site: {
        id: string;
        name: string;
        hostname: string;
        category: string;
        url: string;
        status: number | null;
        source?: string;
      };
    }
  | {
      type: "progress";
      checked: number;
      total: number;
      hits: number;
      errors: number;
      elapsed_ms: number;
    }
  | {
      type: "done";
      checked: number;
      total: number;
      hits: number;
      errors: number;
      elapsed_ms: number;
    };

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
  const { api, method, path, headers, query, body, file, onStreamEvent, signal } = input;

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
    signal,
  };

  // Streaming-режим: если caller дал onStreamEvent — просим SSE.
  const wantStream = typeof onStreamEvent === "function";
  if (wantStream) {
    reqHeaders.set("Accept", "text/event-stream");
  }

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

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const contentType = responseHeaders["content-type"] ?? "";

    // SSE-ветка: bus stream → onStreamEvent + копим RunResult.
    if (
      wantStream &&
      contentType.includes("text/event-stream") &&
      res.body
    ) {
      return await consumeSSE({
        res,
        contentType,
        responseHeaders,
        displayURL,
        path,
        t0,
        onStreamEvent: onStreamEvent!,
      });
    }

    const rawText = await res.text();
    const durationMs = Math.round(performance.now() - t0);
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

/**
 * Парсит SSE-стрим (`text/event-stream`) и накапливает результат в osint-fan-out
 * структуру (`{command, results: {usersearcher: {sites: [...]}}, ...}`),
 * вызывая onStreamEvent на каждом событии для прогрессивного UI.
 */
async function consumeSSE(args: {
  res: Response;
  contentType: string;
  responseHeaders: Record<string, string>;
  displayURL: string;
  path: string;
  t0: number;
  onStreamEvent: (ev: StreamEvent, snapshot: RunResult) => void;
}): Promise<RunResult> {
  const { res, contentType, responseHeaders, displayURL, path, t0, onStreamEvent } = args;
  const reader = res.body!.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";

  const sites: Array<Record<string, unknown>> = [];
  let total = 0;
  let username = "";
  let lastProgress: { checked: number; hits: number; errors: number; elapsed_ms: number } | null = null;
  let doneEvent: Extract<StreamEvent, { type: "done" }> | null = null;

  const buildSnapshot = (): RunResult => {
    const stats = doneEvent ?? lastProgress;
    const checked = stats?.checked ?? 0;
    const hits = stats?.hits ?? sites.length;
    const elapsed = doneEvent?.elapsed_ms ?? Math.round(performance.now() - t0);
    const data = {
      ok: true,
      command: "username",
      input: username,
      tools_total: 1,
      tools_ok: 1,
      results: {
        usersearcher: {
          ok: true,
          found: `${hits} sites`,
          sites,
          checked_total: checked,
          errors: stats?.errors ?? 0,
        },
      },
      text: `✓ usersearcher → ${hits}/${total}`,
      took_ms: elapsed,
      streaming: !doneEvent,
    };
    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      durationMs: elapsed,
      contentType,
      size: 0,
      data,
      rawText: "",
      responseHeaders,
      displayURL,
      requestPath: path.split("?")[0] || path,
    };
  };

  const handle = (raw: string) => {
    // SSE message: одна или несколько `data:` строк, объединить значения через "\n"
    const lines = raw.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue; // комментарии/heartbeat
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return;
    const payload = dataLines.join("\n");
    let ev: StreamEvent;
    try {
      ev = JSON.parse(payload) as StreamEvent;
    } catch {
      return;
    }
    if (ev.type === "start") {
      total = ev.total;
      username = ev.username;
    } else if (ev.type === "hit") {
      sites.push({
        site: ev.site.name,
        hostname: ev.site.hostname,
        category: ev.site.category,
        url: ev.site.url,
        status: ev.site.status,
        source: ev.site.source,
        exists: true,
      });
    } else if (ev.type === "progress") {
      lastProgress = {
        checked: ev.checked,
        hits: ev.hits,
        errors: ev.errors,
        elapsed_ms: ev.elapsed_ms,
      };
    } else if (ev.type === "done") {
      doneEvent = ev;
    }
    onStreamEvent(ev, buildSnapshot());
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        handle(chunk);
      }
    }
    if (buf.trim()) handle(buf);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }

  return buildSnapshot();
}
