import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Send, Trash2, Loader2, ChevronRight, ChevronDown, Paperclip, Search, X as XIcon } from "lucide-react";
import { useAPIs } from "../context/APIs";
import { runRequest, type RunResult } from "../lib/request";
import { SmartViewer } from "./SmartViewer";
import { Dropdown } from "./Dropdown";
import type { SavedEndpoint } from "../lib/storage";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type Method = (typeof METHODS)[number];

/** GET = read-only (eye), everything else = edit (pencil). */
function methodMode(m: Method): "read" | "edit" {
  return m === "GET" ? "read" : "edit";
}

interface KV {
  key: string;
  value: string;
}

function toneFor(status: number): "success" | "warn" | "error" | "neutral" {
  if (status === 0) return "error";
  if (status >= 200 && status < 300) return "success";
  if (status >= 300 && status < 400) return "warn";
  if (status >= 400) return "error";
  return "neutral" as never;
}

export function Workspace() {
  const { active, history, pushHistory, setMode } = useAPIs();
  const [method, setMethod] = useState<Method>("GET");
  const [path, setPath] = useState("/");
  const [headers, setHeaders] = useState<KV[]>([]);
  const [query, setQuery] = useState<KV[]>([]);
  const [body, setBody] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [acceptsFile, setAcceptsFile] = useState(false);
  // Для command-mode: когда тапаешь POST endpoint с body={"command":"/X"},
  // в path-input показываем "/X", а реальный POST-путь и body-шаблон сохраняем тут.
  const [commandEndpoint, setCommandEndpoint] = useState<{ path: string; bodyTemplate: string } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  // Mobile-only: Request panel can be collapsed so the user can read Response
  // full-screen. Open by default. The toggle button only shows on mobile (CSS).
  const [requestCollapsed, setRequestCollapsed] = useState(false);
  const [responseSearch, setResponseSearch] = useState("");

  // Reset request scratchpad when API switches
  useEffect(() => {
    setResult(null);
    setHeaders([]);
    setQuery([]);
    setBody("");
    setMethod("GET");
    setPath("/");
    setCommandEndpoint(null);
  }, [active?.id]);

  // Publish read/edit mode to the topbar banner via context
  useEffect(() => {
    setMode(methodMode(method));
  }, [method, setMode]);

  const recentForActive = useMemo(
    () => (active ? history.filter((h) => h.apiId === active.id).slice(0, 8) : []),
    [active, history]
  );

  // Какие HTTP-методы реально используются в эндпоинтах текущего таба.
  // Если эндпоинтов нет — показываем все, чтобы не лишать юзера ручных запросов.
  // Текущий выбранный method всегда включаем (на случай если переключили таб).
  // ВНИМАНИЕ: хуки должны быть до любого `if (!active) return` — иначе Rules of Hooks
  // ломают render с чёрным экраном.
  const availableMethods = useMemo<readonly Method[]>(() => {
    if (!active?.endpoints || active.endpoints.length === 0) return METHODS;
    const used = new Set<Method>();
    for (const ep of active.endpoints) {
      if ((METHODS as readonly string[]).includes(ep.method)) {
        used.add(ep.method as Method);
      }
    }
    used.add(method);
    return METHODS.filter((m) => used.has(m));
  }, [active, method]);

  // Live-search по командам пресета: substring match по cmd/path/label.
  // Активен всегда когда path не пуст. Результаты сортируются: точное совпадение
  // → startsWith → includes. Лимит 8. Помогает находить команды по 1-2 буквам.
  const cmdSuggestions = useMemo(() => {
    if (!path || !active?.endpoints) return [];
    const q = path.trim().toLowerCase();
    if (q.length < 1) return [];
    type S = { ep: SavedEndpoint; cmd: string; score: number };
    const out: S[] = [];
    for (const ep of active.endpoints) {
      // Достаём то по чему ищем: для POST с command — body.command,
      // для остальных — ep.path.
      let cmd: string = ep.path;
      let isCmd = false;
      if (ep.method === "POST" && typeof ep.body === "string") {
        try {
          const obj = JSON.parse(ep.body);
          if (typeof obj?.command === "string") {
            cmd = obj.command;
            isCmd = true;
          }
        } catch {
          /* not json — fall back to path */
        }
      }
      const lcmd = cmd.toLowerCase();
      const llabel = ep.label.toLowerCase();
      // Точное совпадение — пропускаем (юзер уже на этой команде).
      if (lcmd === q) continue;
      // Релевантность: чем меньше score — тем выше в списке.
      let score: number;
      if (lcmd.startsWith(q)) score = 0;
      else if (llabel.startsWith(q)) score = 1;
      else if (lcmd.includes(q)) score = 2;
      else if (llabel.includes(q)) score = 3;
      else continue;
      out.push({ ep, cmd, score, isCmd } as S & { isCmd: boolean });
    }
    out.sort((a, b) => a.score - b.score || a.cmd.localeCompare(b.cmd));
    return out.slice(0, 8) as (S & { isCmd: boolean })[];
  }, [path, active]);

  // Превью того, что улетит — короткая подсказка под path-input.
  const sendPreview = useMemo(() => {
    if (!body || !body.trim()) return null;
    try {
      const obj = JSON.parse(body);
      if (obj && typeof obj === "object" && typeof obj.command === "string") {
        return { kind: "command" as const, value: obj.command };
      }
    } catch {
      /* not json */
    }
    const trimmed = body.trim().replace(/\s+/g, " ");
    return {
      kind: "raw" as const,
      value: trimmed.length > 80 ? trimmed.slice(0, 80) + "…" : trimmed,
    };
  }, [body]);

  if (!active) {
    return (
      <div className="workspace">
        <div className="empty-state">
          <div className="empty-state-icon">
            <Plus size={22} strokeWidth={1.5} />
          </div>
          <h2>Подключи свой первый API</h2>
          <p>
            Жми «+» на табе сверху, введи URL и токен — и получишь универсальный
            интерфейс для управления любым API.
          </p>
        </div>
      </div>
    );
  }

  async function send(
    override?: Partial<{ method: Method; path: string; body: string }>
  ) {
    if (!active || running) return;
    let useMethod = override?.method ?? method;
    let usePath = override?.path ?? path;
    let useBody = override?.body ?? body;

    // Command mode: в path-input лежит команда, реальный POST идёт в commandEndpoint.path
    // с body={...template, command: <input>}.
    if (commandEndpoint && !override) {
      useMethod = "POST";
      usePath = commandEndpoint.path;
      try {
        const tpl = JSON.parse(commandEndpoint.bodyTemplate);
        useBody = JSON.stringify({ ...tpl, command: path });
      } catch {
        useBody = JSON.stringify({ command: path });
      }
    }

    setRunning(true);
    setResult(null);
    // Универсально: всегда подписываемся на стрим. Если бэк отдаст
    // text/event-stream — request.ts сам распарсит SSE и вызовет
    // onStreamEvent на каждом событии. Если JSON — обычный путь.
    // Без хардкода под конкретный API.
    const res = await runRequest({
      api: active,
      method: useMethod,
      path: usePath,
      headers,
      query,
      body: useBody,
      file: acceptsFile && file ? file : undefined,
      onStreamEvent: (_ev, snapshot) => {
        setResult(snapshot);
      },
    });
    setResult(res);
    setRunning(false);
    pushHistory({
      apiId: active.id,
      method: useMethod,
      path: usePath,
      status: res.status,
      durationMs: res.durationMs,
    });
  }

  return (
    <div className="workspace">
      <div className="runner" data-command-mode={!!commandEndpoint}>
        <Dropdown<Method>
          className="method-select"
          ariaLabel="HTTP method"
          value={method}
          onChange={(m) => {
            setMethod(m);
            setCommandEndpoint(null);
          }}
          triggerProps={{ "data-method": method } as React.ButtonHTMLAttributes<HTMLButtonElement>}
          triggerStyle={{ color: `var(--method-${method.toLowerCase()})` }}
          options={availableMethods.map((m) => ({
            value: m,
            label: m,
            color: `var(--method-${m.toLowerCase()})`,
          }))}
          menuWidth="auto"
        />
        <span className="path-prefix" title={active.baseURL}>
          {active.baseURL.replace(/^https?:\/\//, "")}
        </span>
        <input
          className="path-input"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/users/me"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          inputMode="url"
          aria-label="Endpoint path"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          type="button"
          className="btn btn--primary run-btn"
          onClick={() => send()}
          disabled={running}
        >
          {running ? (
            <Loader2 size={14} strokeWidth={2} className="spin" />
          ) : (
            <Send size={14} strokeWidth={2} />
          )}
          <span>{running ? "Sending…" : "Send"}</span>
        </button>
      </div>
      {cmdSuggestions.length > 0 && (
        <div className="cmd-suggest">
          {cmdSuggestions.map(({ ep, cmd, isCmd }) => (
            <button
              key={ep.label + cmd}
              type="button"
              className="cmd-suggest-item"
              onClick={() => {
                if (isCmd) {
                  setMethod("POST");
                  setPath(cmd);
                  setBody("");
                  setCommandEndpoint({ path: ep.path, bodyTemplate: ep.body || "" });
                } else {
                  setMethod(ep.method as Method);
                  setPath(ep.path);
                  setBody(ep.body || "");
                  setCommandEndpoint(null);
                }
              }}
              title={ep.label}
            >
              {!isCmd && (
                <span className="cmd-suggest-method" data-method={ep.method}>
                  {ep.method}
                </span>
              )}
              <span className="cmd-suggest-cmd">{cmd}</span>
              <span className="cmd-suggest-label">{ep.label}</span>
            </button>
          ))}
        </div>
      )}
      {sendPreview && (
        <div className="send-preview" data-kind={sendPreview.kind}>
          <span className="send-preview-arrow">▶</span>
          <span className="send-preview-value">{sendPreview.value}</span>
        </div>
      )}

      <div className="split">
        <div
          className="panel"
          data-panel="request"
          data-collapsed={requestCollapsed}
        >
          <button
            type="button"
            className="panel-header panel-header-toggle"
            onClick={() => setRequestCollapsed((v) => !v)}
            aria-expanded={!requestCollapsed}
            aria-label={requestCollapsed ? "Развернуть запрос" : "Свернуть запрос"}
          >
            <h3 className="panel-title">Request</h3>
            <ChevronDown
              size={16}
              strokeWidth={2}
              className="panel-chevron"
              data-open={!requestCollapsed}
            />
          </button>
          <div className="panel-body">
            {acceptsFile && (
              <FileSection file={file} onChange={setFile} />
            )}
            {method !== "GET" && method !== "DELETE" && (
              <BodyEditor body={body} onChange={setBody} />
            )}
            <KVSection
              label="Query parameters"
              rows={query}
              onChange={setQuery}
              keyPlaceholder="param"
              valuePlaceholder="value"
            />
            <KVSection
              label="Headers"
              rows={headers}
              onChange={setHeaders}
              keyPlaceholder="header"
              valuePlaceholder="value"
            />
            {(query.length === 0 || headers.length === 0) && (
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-muted)",
                  padding: "4px 0",
                }}
              >
                {query.length === 0 && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                    onClick={() => setQuery([{ key: "", value: "" }])}
                  >
                    <Plus size={10} strokeWidth={2} />
                    <span style={{ marginLeft: 2 }}>Query</span>
                  </button>
                )}
                {headers.length === 0 && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ height: 22, padding: "0 8px", fontSize: 11 }}
                    onClick={() => setHeaders([{ key: "", value: "" }])}
                  >
                    <Plus size={10} strokeWidth={2} />
                    <span style={{ marginLeft: 2 }}>Header</span>
                  </button>
                )}
              </div>
            )}
            {active.endpoints && active.endpoints.length > 0 && (
              <EndpointsList
                endpoints={active.endpoints}
                onPick={(ep) => {
                  // Если POST с body, в котором есть "command" — переходим в command-mode:
                  // в path-input показываем команду, реальный путь и шаблон храним.
                  if (ep.method === "POST" && typeof ep.body === "string") {
                    try {
                      const obj = JSON.parse(ep.body);
                      if (obj && typeof obj === "object" && typeof obj.command === "string") {
                        setMethod("POST");
                        setPath(obj.command);
                        setBody("");
                        setCommandEndpoint({ path: ep.path, bodyTemplate: ep.body });
                        return;
                      }
                    } catch {
                      /* not json — fall through */
                    }
                  }
                  setMethod(ep.method as Method);
                  setPath(ep.path);
                  setBody(ep.body !== undefined ? ep.body : "");
                  setAcceptsFile(!!ep.acceptsFile);
                  setFile(null);
                  setCommandEndpoint(null);
                }}
              />
            )}

            {recentForActive.length > 0 && (
              <div className="section" style={{ marginTop: 24 }}>
                <div className="section-label">Recent</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {recentForActive.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      onClick={() => {
                        setMethod(h.method as Method);
                        setPath(h.path);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "6px 8px",
                        border: "1px solid transparent",
                        background: "transparent",
                        borderRadius: "var(--radius-sm)",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        fontFamily: "var(--font-mono)",
                        fontSize: 12,
                        textAlign: "left",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-overlay)";
                        e.currentTarget.style.borderColor = "var(--border-muted)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = "transparent";
                        e.currentTarget.style.borderColor = "transparent";
                      }}
                    >
                      <span
                        style={{
                          width: 44,
                          flexShrink: 0,
                          fontWeight: 700,
                          fontSize: 11,
                          color: `var(--method-${h.method.toLowerCase()})`,
                        }}
                      >
                        {h.method}
                      </span>
                      <span
                        style={{
                          flex: 1,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          color: "var(--text-primary)",
                        }}
                      >
                        {h.path}
                      </span>
                      <span
                        className="status-badge"
                        data-tone={toneFor(h.status)}
                        style={{ height: 18, fontSize: 10, padding: "0 6px" }}
                      >
                        {h.status || "ERR"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="panel" data-panel="response">
          <div className="panel-header">
            <h3 className="panel-title">Response</h3>
            {result && (
              <div
                style={{
                  position: "relative",
                  flex: "1 1 160px",
                  minWidth: 100,
                  maxWidth: 280,
                  margin: "0 12px",
                }}
              >
                <Search
                  size={12}
                  strokeWidth={1.8}
                  style={{
                    position: "absolute",
                    top: "50%",
                    left: 8,
                    transform: "translateY(-50%)",
                    color: "var(--text-muted)",
                    pointerEvents: "none",
                  }}
                />
                <input
                  type="text"
                  className="kv-input"
                  value={responseSearch}
                  onChange={(e) => setResponseSearch(e.target.value)}
                  placeholder="поиск в ответе"
                  spellCheck={false}
                  style={{
                    width: "100%",
                    height: 26,
                    fontSize: 12,
                    paddingLeft: 26,
                  }}
                />
              </div>
            )}
            {result && (
              <div className="panel-meta">
                <span
                  className="status-badge"
                  data-tone={toneFor(result.status)}
                >
                  {result.status || "ERR"}{" "}
                  {result.statusText || result.error || ""}
                </span>
                <span>{result.durationMs} ms</span>
                <span>{formatSize(result.size)}</span>
              </div>
            )}
          </div>
          <div className="panel-body">
            {!result ? (
              <div className="response-empty">
                <Send size={20} strokeWidth={1.5} />
                <div>Жми Send или Enter в поле path, чтобы выполнить запрос.</div>
              </div>
            ) : result.error ? (
              <div className="response-empty" style={{ color: "var(--status-high)" }}>
                <div style={{ fontWeight: 600 }}>{result.error}</div>
                <div style={{ color: "var(--text-muted)", fontSize: 12 }}>
                  Часто это CORS — попробуй API, который разрешает браузерные запросы,
                  или используй прокси.
                </div>
              </div>
            ) : (
              <SmartViewer
                data={result.data}
                rawText={result.rawText}
                currentRequestPath={result.requestPath}
                apiBaseURL={active.baseURL}
                apiToken={active.auth?.token}
                searchQuery={responseSearch}
                onNavigateFile={(entry, currentPath) => {
                  // Стратегия: меняем хвост path после `/contents/` на entry.path.
                  // Пример: /repos/o/r/contents/src/foo + entry "src/bar"
                  //         → /repos/o/r/contents/src/bar
                  const m = currentPath.match(/^(\/repos\/[^/]+\/[^/]+\/contents\/)/);
                  if (!m) return;
                  const newPath = m[1] + entry.path;
                  setMethod("GET");
                  setPath(newPath);
                  send({ method: "GET", path: newPath, body: "" });
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function FileSection({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const previewURL = useMemo(() => {
    if (!file || !file.type.startsWith("image/")) return null;
    return URL.createObjectURL(file);
  }, [file]);
  useEffect(() => {
    return () => {
      if (previewURL) URL.revokeObjectURL(previewURL);
    };
  }, [previewURL]);

  return (
    <div className="section">
      <div className="section-label" style={{ userSelect: "none" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <Paperclip size={12} strokeWidth={2} />
          File
          {file && (
            <span
              className="status-badge"
              data-tone="success"
              style={{ height: 16, fontSize: 9, padding: "0 6px" }}
            >
              {formatSize(file.size)}
            </span>
          )}
        </span>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          onChange(f);
          e.target.value = "";
        }}
      />
      {!file ? (
        <button
          type="button"
          className="btn btn--ghost"
          style={{ width: "100%", justifyContent: "center", padding: "12px 0" }}
          onClick={() => inputRef.current?.click()}
        >
          <Paperclip size={14} strokeWidth={1.8} />
          <span style={{ marginLeft: 6 }}>Выбрать фото</span>
        </button>
      ) : (
        <div
          style={{
            display: "flex",
            gap: 10,
            alignItems: "center",
            padding: 8,
            border: "1px solid var(--border-muted)",
            borderRadius: "var(--radius-sm)",
            background: "var(--bg-overlay)",
          }}
        >
          {previewURL ? (
            <img
              src={previewURL}
              alt={file.name}
              style={{
                width: 56,
                height: 56,
                objectFit: "cover",
                borderRadius: "var(--radius-sm)",
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: 56,
                height: 56,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--bg-surface)",
                borderRadius: "var(--radius-sm)",
                flexShrink: 0,
              }}
            >
              <Paperclip size={20} strokeWidth={1.6} />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12 }}>
            <div
              style={{
                color: "var(--text-primary)",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {file.name}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
              {file.type || "?"} · {formatSize(file.size)}
            </div>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Убрать файл"
            onClick={() => onChange(null)}
          >
            <XIcon size={14} strokeWidth={1.8} />
          </button>
        </div>
      )}
    </div>
  );
}

function JsonHighlightTextarea({
  body, onChange,
}: { body: string; onChange: (s: string) => void }) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  const syncScroll = () => {
    if (taRef.current && preRef.current) {
      preRef.current.scrollTop = taRef.current.scrollTop;
      preRef.current.scrollLeft = taRef.current.scrollLeft;
    }
  };

  const sharedStyle: React.CSSProperties = {
    margin: 0,
    padding: 10,
    fontFamily: "var(--font-mono)",
    lineHeight: 1.5,
    border: "1px solid var(--border-muted)",
    borderRadius: "var(--radius-sm)",
    boxSizing: "border-box",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    width: "100%",
    minHeight: 80,
    maxHeight: 280,
  };

  return (
    <div style={{ position: "relative", width: "100%" }} className="json-body-wrap">
      <pre
        ref={preRef}
        aria-hidden
        className="json-body-pre"
        style={{
          ...sharedStyle,
          position: "absolute",
          inset: 0,
          background: "var(--bg-overlay)",
          color: "var(--text-primary)",
          pointerEvents: "none",
          overflow: "hidden",
        }}
      >
        {renderJsonHighlight(body)}
        {"​"}
      </pre>
      <textarea
        ref={taRef}
        className="json-body-textarea"
        value={body}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="none"
        autoComplete="off"
        inputMode="text"
        placeholder='{"input":"vasya_kartoplya"}'
        style={{
          ...sharedStyle,
          position: "relative",
          background: "transparent",
          color: "transparent",
          WebkitTextFillColor: "transparent",
          caretColor: "var(--text-primary)",
          resize: "vertical",
          outline: "none",
          overflow: "auto",
        }}
      />
    </div>
  );
}

function renderJsonHighlight(src: string): React.ReactNode {
  // Best-effort токенайзер: не падает на невалидном JSON.
  // Серый = "не трогай" (ключи, скобки, разделители).
  // Белый = "редактируй" (значения, числа, true/false).
  const muted = "var(--text-muted)";
  const accent = "var(--text-primary)";
  const tokens: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j += 2;
        else j += 1;
      }
      const closed = j < src.length;
      const literal = src.slice(i, closed ? j + 1 : src.length);
      let isKey = false;
      if (closed) {
        let k = j + 1;
        while (k < src.length && /\s/.test(src[k])) k++;
        isKey = src[k] === ":";
      }
      if (isKey) {
        tokens.push(<span key={key++} style={{ color: muted }}>{literal}</span>);
      } else {
        tokens.push(<span key={key++} style={{ color: muted }}>"</span>);
        const inner = closed ? literal.slice(1, -1) : literal.slice(1);
        if (inner) tokens.push(<span key={key++} style={{ color: accent }}>{inner}</span>);
        if (closed) tokens.push(<span key={key++} style={{ color: muted }}>"</span>);
      }
      i = closed ? j + 1 : src.length;
      continue;
    }
    if ("{}[]:,".includes(ch)) {
      tokens.push(<span key={key++} style={{ color: muted }}>{ch}</span>);
      i++;
      continue;
    }
    tokens.push(<span key={key++} style={{ color: accent }}>{ch}</span>);
    i++;
  }
  return tokens;
}

function BodyEditor({ body, onChange }: { body: string; onChange: (s: string) => void }) {
  const [open, setOpen] = useState(true);

  const parse = useMemo(() => {
    if (!body.trim()) return { ok: true as const, kind: "empty" as const };
    try {
      JSON.parse(body);
      return { ok: true as const, kind: "json" as const };
    } catch (e) {
      return { ok: false as const, kind: "invalid" as const, error: (e as Error).message };
    }
  }, [body]);

  const prettify = () => {
    try {
      const v = JSON.parse(body);
      onChange(JSON.stringify(v, null, 2));
    } catch {
      /* leave as-is */
    }
  };

  const sizeBytes = new TextEncoder().encode(body).length;

  return (
    <div className="section">
      <div
        className="section-label"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <ChevronRight
            size={12}
            strokeWidth={2}
            className="preset-category-chevron"
            data-open={open}
          />
          Body
          {body.trim() && (
            <span
              className="status-badge"
              data-tone={parse.ok ? "success" : "error"}
              style={{ height: 16, fontSize: 9, padding: "0 6px" }}
            >
              {parse.ok ? `JSON · ${formatSize(sizeBytes)}` : "invalid"}
            </span>
          )}
        </span>
        {parse.ok && parse.kind === "json" && (
          <button
            type="button"
            className="btn btn--ghost"
            style={{ height: 24, padding: "0 8px", fontSize: 11 }}
            onClick={(e) => {
              e.stopPropagation();
              prettify();
            }}
          >
            Pretty
          </button>
        )}
      </div>
      {open && (
        <>
          <JsonHighlightTextarea body={body} onChange={onChange} />
          {!parse.ok && (
            <div style={{ fontSize: 11, color: "var(--method-delete, #f87171)", marginTop: 4 }}>
              {parse.error}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function KVSection({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  rows: KV[];
  onChange: (rows: KV[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
}) {
  // Hook на верхнем уровне до early return.
  const [open, setOpen] = useState(true);

  // Если пусто — не рендерим вообще: на телефоне эти секции забирают высоту.
  if (rows.length === 0) return null;

  return (
    <div className="section">
      <div
        className="section-label"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <ChevronRight
            size={12}
            strokeWidth={2}
            className="preset-category-chevron"
            data-open={open}
          />
          {label}
          {rows.length > 0 && (
            <span className="preset-category-count" style={{ height: 16, minWidth: 18, fontSize: 9 }}>
              {rows.length}
            </span>
          )}
        </span>
        <button
          type="button"
          className="btn btn--ghost"
          style={{ height: 24, padding: "0 8px", fontSize: 11 }}
          onClick={(e) => {
            e.stopPropagation();
            onChange([...rows, { key: "", value: "" }]);
            setOpen(true);
          }}
        >
          <Plus size={11} strokeWidth={2} />
          <span style={{ marginLeft: 2 }}>Add</span>
        </button>
      </div>
      {open && (rows.length === 0 ? (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-muted)",
            padding: "6px 0",
          }}
        >
          —
        </div>
      ) : (
        rows.map((row, i) => (
          <div key={i} className="kv-row">
            <input
              className="kv-input"
              value={row.key}
              placeholder={keyPlaceholder}
              spellCheck={false}
              onChange={(e) => {
                const next = rows.slice();
                next[i] = { ...row, key: e.target.value };
                onChange(next);
              }}
            />
            <input
              className="kv-input"
              value={row.value}
              placeholder={valuePlaceholder}
              spellCheck={false}
              onChange={(e) => {
                const next = rows.slice();
                next[i] = { ...row, value: e.target.value };
                onChange(next);
              }}
            />
            <button
              type="button"
              className="kv-remove"
              aria-label="Remove"
              onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            >
              <Trash2 size={12} strokeWidth={1.6} />
            </button>
          </div>
        ))
      ))}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const UNCATEGORIZED = "Без категории";

function EndpointsList({
  endpoints,
  onPick,
}: {
  endpoints: SavedEndpoint[];
  onPick: (ep: SavedEndpoint) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, SavedEndpoint[]>();
    for (const ep of endpoints) {
      const cat = ep.category?.trim() || UNCATEGORIZED;
      const arr = map.get(cat) ?? [];
      arr.push(ep);
      map.set(cat, arr);
    }
    return Array.from(map.entries()).map(([category, items]) => ({
      category,
      items,
    }));
  }, [endpoints]);

  const allCategories = useMemo(() => groups.map((g) => g.category), [groups]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (cat: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  // If only "Без категории" — render as a flat list (no chevron noise).
  const flat = groups.length === 1 && groups[0].category === UNCATEGORIZED;

  return (
    <div className="section" style={{ marginTop: 24 }}>
      <div className="section-label">
        <span>Эндпоинты</span>
        {!flat && (
          <div style={{ display: "flex", gap: 6 }}>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ height: 22, padding: "0 8px", fontSize: 10 }}
              onClick={() => setCollapsed(new Set())}
            >
              Раскрыть всё
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              style={{ height: 22, padding: "0 8px", fontSize: 10 }}
              onClick={() => setCollapsed(new Set(allCategories))}
            >
              Свернуть всё
            </button>
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {groups.map(({ category, items }) => {
          const isCollapsed = collapsed.has(category);
          return (
            <div key={category}>
              {!flat && (
                <button
                  type="button"
                  className="preset-category-header"
                  aria-expanded={!isCollapsed}
                  onClick={() => toggle(category)}
                >
                  <ChevronRight
                    size={14}
                    strokeWidth={2}
                    className="preset-category-chevron"
                    data-open={!isCollapsed}
                  />
                  <span className="preset-category-name">{category}</span>
                  <span className="preset-category-count">{items.length}</span>
                </button>
              )}
              {(flat || !isCollapsed) && (
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {items.map((ep, i) => (
                    <EndpointButton key={i} ep={ep} onClick={() => onPick(ep)} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EndpointButton({
  ep,
  onClick,
}: {
  ep: SavedEndpoint;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 8px",
        border: "1px solid transparent",
        background: "transparent",
        borderRadius: "var(--radius-sm)",
        color: "var(--text-secondary)",
        cursor: "pointer",
        fontFamily: "var(--font-sans)",
        fontSize: 12,
        textAlign: "left",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--bg-overlay)";
        e.currentTarget.style.borderColor = "var(--border-muted)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "transparent";
      }}
    >
      <span
        style={{
          width: 44,
          flexShrink: 0,
          fontWeight: 700,
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: ep.acceptsFile
            ? "var(--text-primary)"
            : `var(--method-${ep.method.toLowerCase()})`,
        }}
      >
        {ep.acceptsFile ? "FILE" : ep.method}
      </span>
      {ep.status && (
        <span className="endpoint-badge" data-status={ep.status}>
          {ep.status === "ready"
            ? "RDY"
            : ep.status === "soon"
              ? "SOON"
              : ep.status === "wip"
                ? "WIP"
                : "ERR"}
        </span>
      )}
      <span
        style={{
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--text-primary)",
        }}
      >
        {ep.label}
      </span>
    </button>
  );
}
