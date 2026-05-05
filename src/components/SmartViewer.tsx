import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Image as ImageIcon,
  Layers,
  Pause,
  Play,
  Rows3,
  FileText,
  Sparkles,
  FileCode,
  FolderOpen,
  Folder,
  File as FileIcon,
} from "lucide-react";
import { collectColumns, findPrimaryArray, previewCell } from "../lib/inspect";

type ViewMode = "pretty" | "media" | "file" | "files" | "tree" | "table" | "raw";

interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file" | "symlink" | "submodule";
  size?: number;
}

/** Распознаём листинг файлов. Поддерживаем два формата:
 *  1) GitHub-style: массив объектов с type/name/path на верхнем уровне
 *  2) veni-detect /files /browse: {result: {items: [{name, path, is_dir, size_bytes}]}} */
function findFileListing(value: unknown): FileEntry[] | null {
  // 1. Прямой массив с GitHub-полями (type)
  if (Array.isArray(value)) return _parseGithubListing(value);
  // 2. Поиск items в value.result.items или value.items (наша нода)
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    let items: unknown = v.items;
    if (!Array.isArray(items) && v.result && typeof v.result === "object") {
      items = (v.result as Record<string, unknown>).items;
    }
    if (Array.isArray(items)) {
      // Сначала пробуем GitHub-формат
      const gh = _parseGithubListing(items);
      if (gh) return gh;
      // Иначе — наша нода: name/path/is_dir
      return _parseNodeListing(items);
    }
  }
  return null;
}

function _parseGithubListing(arr: unknown[]): FileEntry[] | null {
  if (arr.length === 0) return null;
  const out: FileEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    if (
      typeof obj.name !== "string" ||
      typeof obj.path !== "string" ||
      (obj.type !== "dir" && obj.type !== "file" && obj.type !== "symlink" && obj.type !== "submodule")
    ) {
      return null;
    }
    out.push({
      name: obj.name,
      path: obj.path,
      type: obj.type,
      size: typeof obj.size === "number" ? obj.size : undefined,
    });
  }
  return _sortListing(out);
}

function _parseNodeListing(arr: unknown[]): FileEntry[] | null {
  if (arr.length === 0) return null;
  const out: FileEntry[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    if (typeof obj.name !== "string" || typeof obj.path !== "string") return null;
    if (typeof obj.is_dir !== "boolean") return null;
    out.push({
      name: obj.name,
      path: obj.path,
      type: obj.is_dir ? "dir" : "file",
      size: typeof obj.size_bytes === "number" ? obj.size_bytes : undefined,
    });
  }
  return _sortListing(out);
}

function _sortListing(entries: FileEntry[]): FileEntry[] {
  entries.sort((a, b) => {
    if (a.type === "dir" && b.type !== "dir") return -1;
    if (a.type !== "dir" && b.type === "dir") return 1;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

/** Generic «human friendly» fields commonly used by APIs to expose a ready-to-show message. */
const HUMAN_FIELDS = [
  "text",
  "message",
  "description",
  "summary",
  "detail",
  "msg",
];

function findHumanText(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  // Osint-fan-out имеет своё поле `text` со сводкой "✓ tool → ..." —
  // не показываем его как humanText, отдадим OsintFanoutView рендерить блоками.
  if (isOsintFanout(value)) return null;
  for (const key of HUMAN_FIELDS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

function isOsintFanout(value: unknown): value is OsintFanout {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.command === "string" &&
    typeof v.tools_total === "number" &&
    typeof v.tools_ok === "number" &&
    v.results !== null &&
    typeof v.results === "object"
  );
}

interface OsintFanout {
  ok: boolean;
  command: string;
  input?: string;
  tools_total: number;
  tools_ok: number;
  results: Record<string, Record<string, unknown>>;
  took_ms?: number;
  text?: string;
}

/**
 * Распознаём GitHub-style file content: { content: "<base64>", encoding: "base64", name? }
 * Возвращаем декодированный текст или null.
 */
function findFileContent(
  value: unknown
): { name: string | null; text: string; size: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const content = obj.content;
  const encoding = obj.encoding;
  if (typeof content !== "string" || encoding !== "base64") return null;
  try {
    // GitHub возвращает base64 с переносами строк — atob их не любит
    const cleaned = content.replace(/\s+/g, "");
    const binary = atob(cleaned);
    // utf-8 декодинг
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      name: typeof obj.name === "string" ? obj.name : null,
      text,
      size: bytes.byteLength,
    };
  } catch {
    return null;
  }
}

interface Props {
  data: unknown;
  rawText: string;
  /**
   * Колбэк навигации (для File Browser). При клике по папке/файлу в табе Files
   * SmartViewer сообщает path родителю — Workspace сам делает запрос.
   * Получает path относительно родителя репо: если url ответа содержит
   * `/repos/{owner}/{repo}/contents/foo/bar`, navigate("foo/bar/baz") вернёт
   * новый запрос на `/repos/{owner}/{repo}/contents/foo/bar/baz`.
   */
  onNavigateFile?: (entry: FileEntry, currentRequestPath: string) => void;
  /** Текущий path запроса — нужен для навигации (хлебные крошки вверх). */
  currentRequestPath?: string;
  /** Базовый URL текущего таба — нужен чтобы тянуть медиа (img/video/audio/pdf). */
  apiBaseURL?: string;
  /** Bearer-токен текущего таба — для авторизации при fetch медиа. */
  apiToken?: string;
}

/** Возвращает media-ссылку если ответ ноды содержит filename и либо kind,
 *  либо url начинающийся с /api/media/<kind>/. */
function detectMedia(value: unknown): { kind: string; filename: string; relPath: string } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  // veni-detect формат: {ok, result: {kind?, filename, url?, ...}}
  let inner: Record<string, unknown> = v;
  if (typeof v.result === "object" && v.result !== null) {
    inner = v.result as Record<string, unknown>;
  }
  const filename = inner.filename as string | undefined;
  if (typeof filename !== "string") return null;
  let kind = inner.kind as string | undefined;
  let relPath = inner.url as string | undefined;
  // Если в JSON есть url типа /api/media/audio/X.wav — выводим kind из него.
  if (typeof relPath === "string") {
    const m = relPath.match(/^\/api\/media\/([^/]+)\//);
    if (m && !kind) kind = m[1];
  }
  if (typeof kind !== "string") return null;
  if (!["cam", "screen", "audio", "file"].includes(kind)) return null;
  if (!relPath || !relPath.startsWith("/api/media/")) {
    relPath = `/api/media/${encodeURIComponent(kind)}/${encodeURIComponent(filename)}`;
  }
  return { kind, filename, relPath };
}

/** Детектит массив media-items — например ответ /media list audio:
 *  result.items = [{filename, kind, url, size_bytes, ...}, ...]
 *  Возвращает массив relPath+filename+kind или null. */
function detectMediaList(value: unknown): { kind: string; filename: string; relPath: string; size?: number }[] | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  let arr: unknown = (v as Record<string, unknown>).items;
  if (!Array.isArray(arr) && typeof v.result === "object" && v.result !== null) {
    arr = (v.result as Record<string, unknown>).items;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out: { kind: string; filename: string; relPath: string; size?: number }[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") return null;
    const obj = item as Record<string, unknown>;
    const filename = obj.filename as string | undefined;
    if (typeof filename !== "string") return null;
    let kind = obj.kind as string | undefined;
    let relPath = obj.url as string | undefined;
    if (typeof relPath === "string") {
      const m = relPath.match(/^\/api\/media\/([^/]+)\//);
      if (m && !kind) kind = m[1];
    }
    if (typeof kind !== "string") return null;
    if (!["cam", "screen", "audio", "file"].includes(kind)) return null;
    if (!relPath || !relPath.startsWith("/api/media/")) {
      relPath = `/api/media/${encodeURIComponent(kind)}/${encodeURIComponent(filename)}`;
    }
    const size = typeof obj.size_bytes === "number" ? obj.size_bytes : undefined;
    out.push({ kind, filename, relPath, size });
  }
  return out.length > 0 ? out : null;
}

function mimeFromName(name: string): { kind: "image" | "video" | "audio" | "pdf" | "text" | "other"; mime: string } {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, { kind: "image" | "video" | "audio" | "pdf" | "text"; mime: string }> = {
    png: { kind: "image", mime: "image/png" },
    jpg: { kind: "image", mime: "image/jpeg" },
    jpeg: { kind: "image", mime: "image/jpeg" },
    gif: { kind: "image", mime: "image/gif" },
    webp: { kind: "image", mime: "image/webp" },
    heic: { kind: "image", mime: "image/heic" },
    bmp: { kind: "image", mime: "image/bmp" },
    svg: { kind: "image", mime: "image/svg+xml" },
    mp4: { kind: "video", mime: "video/mp4" },
    mov: { kind: "video", mime: "video/quicktime" },
    webm: { kind: "video", mime: "video/webm" },
    mkv: { kind: "video", mime: "video/x-matroska" },
    mp3: { kind: "audio", mime: "audio/mpeg" },
    wav: { kind: "audio", mime: "audio/wav" },
    m4a: { kind: "audio", mime: "audio/mp4" },
    flac: { kind: "audio", mime: "audio/flac" },
    ogg: { kind: "audio", mime: "audio/ogg" },
    pdf: { kind: "pdf", mime: "application/pdf" },
    txt: { kind: "text", mime: "text/plain" },
    md: { kind: "text", mime: "text/markdown" },
    json: { kind: "text", mime: "application/json" },
    csv: { kind: "text", mime: "text/csv" },
    log: { kind: "text", mime: "text/plain" },
  };
  return map[ext] || { kind: "other", mime: "application/octet-stream" };
}

export function SmartViewer({
  data,
  rawText,
  onNavigateFile,
  currentRequestPath,
  apiBaseURL,
  apiToken,
}: Props) {
  const primaryArray = useMemo(() => findPrimaryArray(data), [data]);
  const humanText = useMemo(() => findHumanText(data), [data]);
  const fileContent = useMemo(() => findFileContent(data), [data]);
  const fileListing = useMemo(() => findFileListing(data), [data]);
  const media = useMemo(() => detectMedia(data), [data]);
  const mediaList = useMemo(() => detectMediaList(data), [data]);
  const hasPretty =
    humanText !== null ||
    (data !== null &&
      data !== undefined &&
      (typeof data === "object" || typeof data === "string"));
  // Приоритет: media (одиночный) → mediaList → file → files → pretty → table → tree.
  const [mode, setMode] = useState<ViewMode>(
    media && apiBaseURL
      ? "media"
      : mediaList && apiBaseURL
        ? "media"
        : fileContent
          ? "file"
          : fileListing
            ? "files"
            : humanText
              ? "pretty"
              : primaryArray
                ? "table"
                : "tree"
  );

  const tabs: { id: ViewMode; label: string; icon: React.ReactNode; show: boolean }[] = [
    {
      id: "media",
      label: "Media",
      icon: <ImageIcon size={13} strokeWidth={1.6} />,
      show: (!!media || !!mediaList) && !!apiBaseURL,
    },
    {
      id: "file",
      label: "File",
      icon: <FileCode size={13} strokeWidth={1.6} />,
      show: !!fileContent,
    },
    {
      id: "files",
      label: "Files",
      icon: <FolderOpen size={13} strokeWidth={1.6} />,
      show: !!fileListing,
    },
    {
      id: "pretty",
      label: "Pretty",
      icon: <Sparkles size={13} strokeWidth={1.6} />,
      show: hasPretty,
    },
    {
      id: "table",
      label: "Table",
      icon: <Rows3 size={13} strokeWidth={1.6} />,
      show: !!primaryArray,
    },
    { id: "tree", label: "Tree", icon: <Layers size={13} strokeWidth={1.6} />, show: true },
    { id: "raw", label: "Raw", icon: <FileText size={13} strokeWidth={1.6} />, show: true },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="viewer-tabs">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setMode(t.id)}
              className="btn btn--ghost"
              data-active={mode === t.id}
              style={{
                height: 28,
                padding: "0 10px",
                fontSize: 12,
                background: mode === t.id ? "var(--bg-overlay)" : "transparent",
                color: mode === t.id ? "var(--text-primary)" : "var(--text-secondary)",
                border: `1px solid ${mode === t.id ? "var(--border)" : "transparent"}`,
              }}
            >
              {t.icon}
              <span style={{ marginLeft: 4 }}>{t.label}</span>
            </button>
          ))}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn--ghost"
          style={{ height: 28, padding: "0 10px", fontSize: 12 }}
          onClick={() => navigator.clipboard.writeText(rawText)}
          title="Copy raw response"
        >
          <Copy size={13} strokeWidth={1.6} />
          <span style={{ marginLeft: 4 }}>Copy</span>
        </button>
      </div>

      {mode === "media" && media && apiBaseURL && (
        <MediaView
          baseURL={apiBaseURL}
          token={apiToken}
          relPath={media.relPath}
          filename={media.filename}
        />
      )}
      {mode === "media" && !media && mediaList && apiBaseURL && (
        <MediaListView
          baseURL={apiBaseURL}
          token={apiToken}
          items={mediaList}
        />
      )}
      {mode === "file" && fileContent && <FileView file={fileContent} />}
      {mode === "files" && fileListing && (
        <FilesView
          entries={fileListing}
          currentRequestPath={currentRequestPath}
          onNavigate={onNavigateFile}
        />
      )}
      {mode === "pretty" && <PrettyView value={data} humanText={humanText} />}
      {mode === "tree" && <TreeView value={data} />}
      {mode === "table" && primaryArray && <TableView rows={primaryArray} />}
      {mode === "raw" && (
        <pre className="response-area" style={{ margin: 0 }}>
          {rawText}
        </pre>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   TREE VIEW
   ───────────────────────────────────────────── */
function TreeView({ value }: { value: unknown }) {
  return (
    <div className="response-area">
      <TreeNode value={value} depth={0} isRoot />
    </div>
  );
}

const MAX_DEPTH = 64;

function TreeNode({
  value,
  depth,
  keyName,
  isRoot,
  isLast,
}: {
  value: unknown;
  depth: number;
  keyName?: string;
  isRoot?: boolean;
  isLast?: boolean;
}) {
  const [open, setOpen] = useState(depth < 2);

  const indent = { paddingLeft: depth === 0 ? 0 : 16 };

  if (depth > MAX_DEPTH) {
    return (
      <div style={indent}>
        <span className="json-punct">…</span>
        <span className="json-null" style={{ marginLeft: 6, fontSize: 11 }}>
          (max depth reached)
        </span>
      </div>
    );
  }
  const keyEl = keyName !== undefined ? <span className="json-key">"{keyName}"</span> : null;
  const colon = keyName !== undefined ? <span className="json-punct">: </span> : null;
  const comma = !isLast && !isRoot ? <span className="json-punct">,</span> : null;

  if (value === null) {
    return (
      <div style={indent}>
        {keyEl}
        {colon}
        <span className="json-null">null</span>
        {comma}
      </div>
    );
  }
  if (typeof value === "string") {
    return (
      <div style={indent}>
        {keyEl}
        {colon}
        <span className="json-str">"{value}"</span>
        {comma}
      </div>
    );
  }
  if (typeof value === "number") {
    return (
      <div style={indent}>
        {keyEl}
        {colon}
        <span className="json-num">{value}</span>
        {comma}
      </div>
    );
  }
  if (typeof value === "boolean") {
    return (
      <div style={indent}>
        {keyEl}
        {colon}
        <span className="json-bool">{String(value)}</span>
        {comma}
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown])
    : Object.entries(value as Record<string, unknown>);

  const open_brk = isArray ? "[" : "{";
  const close_brk = isArray ? "]" : "}";

  return (
    <div style={indent}>
      <div
        style={{ display: "flex", alignItems: "center", cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen(!open)}
      >
        <span style={{ display: "inline-flex", marginRight: 2, color: "var(--text-muted)" }}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        {keyEl}
        {colon}
        <span className="json-punct">{open_brk}</span>
        {!open && (
          <>
            <span className="json-punct" style={{ opacity: 0.6, marginLeft: 4 }}>
              {entries.length} {isArray ? "item" + (entries.length === 1 ? "" : "s") : "key" + (entries.length === 1 ? "" : "s")}
            </span>
            <span className="json-punct">{close_brk}</span>
            {comma}
          </>
        )}
      </div>
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <TreeNode
              key={k}
              value={v}
              keyName={isArray ? undefined : k}
              depth={depth + 1}
              isLast={i === entries.length - 1}
            />
          ))}
          <div>
            <span className="json-punct">{close_brk}</span>
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────
   TABLE VIEW
   ───────────────────────────────────────────── */
function TableView({ rows }: { rows: unknown[] }) {
  const cols = useMemo(() => collectColumns(rows, 8), [rows]);
  const [expanded, setExpanded] = useState<number | null>(null);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        background: "var(--bg-canvas)",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border-muted)",
          fontSize: 11,
          color: "var(--text-secondary)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          fontWeight: 600,
        }}
      >
        {rows.length} {rows.length === 1 ? "row" : "rows"} · {cols.length}{" "}
        {cols.length === 1 ? "column" : "columns"}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
            fontFamily: "var(--font-mono)",
          }}
        >
          <thead>
            <tr>
              <th style={thStyle}>#</th>
              {cols.map((c) => (
                <th key={c} style={thStyle}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row, i) => {
              const obj =
                row && typeof row === "object" && !Array.isArray(row)
                  ? (row as Record<string, unknown>)
                  : {};
              const isOpen = expanded === i;
              const main = (
                <tr
                  key={i}
                  onClick={() => setExpanded(isOpen ? null : i)}
                  style={{
                    cursor: "pointer",
                    background: isOpen ? "var(--bg-overlay)" : "transparent",
                    borderTop: i === 0 ? "none" : "1px solid var(--border-muted)",
                  }}
                >
                  <td style={{ ...tdStyle, color: "var(--text-muted)", width: 36 }}>{i}</td>
                  {cols.map((c) => (
                    <td key={c} style={tdStyle}>
                      <span
                        style={{
                          display: "inline-block",
                          maxWidth: 280,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          verticalAlign: "middle",
                        }}
                        title={previewCell(obj[c])}
                      >
                        {previewCell(obj[c])}
                      </span>
                    </td>
                  ))}
                </tr>
              );
              if (!isOpen) return [main];
              return [
                main,
                <tr key={`${i}-detail`}>
                  <td
                    colSpan={cols.length + 1}
                    style={{
                      padding: "8px 16px",
                      background: "var(--bg-canvas)",
                      borderTop: "1px solid var(--border-muted)",
                    }}
                  >
                    <TreeNode value={row} depth={0} isRoot />
                  </td>
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  background: "var(--bg-surface)",
  borderBottom: "1px solid var(--border)",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-secondary)",
  whiteSpace: "nowrap",
  position: "sticky",
  top: 0,
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  color: "var(--text-primary)",
  verticalAlign: "top",
};

/* ─────────────────────────────────────────────
   PRETTY VIEW — universal human-readable
   ─────────────────────────────────────────────
   Стратегия:
   1. Если в ответе есть human-friendly поле (text/message/description/...) — показываем
      его как pre-formatted текст с переносами и эмодзи (это как раз то что API
      обычно готовит для отображения).
   2. Иначе раскладываем объект как «ключ → значение» без скобок и кавычек.
   3. Массив однородных объектов — список карточек.
   4. Скаляры — крупным значением.
   ───────────────────────────────────────────── */
function PrettyView({
  value,
  humanText,
}: {
  value: unknown;
  humanText: string | null;
}) {
  if (isOsintFanout(value)) {
    return <OsintFanoutView data={value} />;
  }
  if (humanText !== null) {
    return (
      <div className="pretty-text">
        {humanText}
      </div>
    );
  }
  return (
    <div className="pretty-root">
      <PrettyAny value={value} />
    </div>
  );
}

function OsintFanoutView({ data }: { data: OsintFanout }) {
  const entries = Object.entries(data.results);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          color: "var(--text-secondary)",
        }}
      >
        <span style={{ color: "var(--text-primary)", fontWeight: 600, textTransform: "uppercase" }}>
          {data.command}
        </span>
        {data.input && <span>· {data.input}</span>}
        <span style={{ flex: 1 }} />
        <span>{data.tools_ok}/{data.tools_total} tools</span>
        {typeof data.took_ms === "number" && <span>· {data.took_ms} ms</span>}
      </div>
      {entries.map(([toolName, result]) => (
        <OsintToolBlock key={toolName} name={toolName} result={result} />
      ))}
    </div>
  );
}

function OsintToolBlock({ name, result }: { name: string; result: Record<string, unknown> }) {
  const ok = result.ok === true;
  const found = typeof result.found === "string" ? result.found : null;
  return (
    <div
      style={{
        border: "1px solid var(--border-muted)",
        borderRadius: "var(--radius-sm)",
        background: "var(--bg-surface)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 12px",
          background: "var(--bg-overlay)",
          borderBottom: "1px solid var(--border-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      >
        <span
          className="status-badge"
          data-tone={ok ? "success" : "error"}
          style={{ height: 18, fontSize: 10, padding: "0 6px" }}
        >
          {ok ? "OK" : "ERR"}
        </span>
        <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{name}</span>
        {found && <span style={{ color: "var(--text-secondary)" }}>→ {found}</span>}
        {!ok && typeof result.error === "string" && (
          <span style={{ color: "var(--text-secondary)" }}>→ {result.error}</span>
        )}
      </div>
      <div style={{ padding: "8px 12px" }}>
        <OsintToolBody result={result} />
      </div>
    </div>
  );
}

function OsintToolBody({ result }: { result: Record<string, unknown> }) {
  // 1. username/sherlock — массив sites: [{site, url, status}] + github_profile (опц.)
  const sites = result.sites;
  if (Array.isArray(sites) && sites.length && isObj(sites[0]) && typeof (sites[0] as Record<string, unknown>).url === "string") {
    const ghp = isObj(result.github_profile) ? (result.github_profile as Record<string, unknown>) : null;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <SitesList items={sites as Array<Record<string, unknown>>} />
        {ghp && <GithubProfile profile={ghp} />}
      </div>
    );
  }
  // 2. domain/crtsh — массив subdomains: ["a.example.com", ...]
  const subdomains = result.subdomains;
  if (Array.isArray(subdomains) && subdomains.length && typeof subdomains[0] === "string") {
    return <ChipList items={subdomains as string[]} kind="domain" />;
  }
  // 3. email/holehe — массив services: ["github.com", "twitter.com", ...]
  const services = result.services;
  if (Array.isArray(services) && services.length && typeof services[0] === "string") {
    return <ChipList items={services as string[]} kind="text" />;
  }
  // 4. domain/dnstwist — permutations: [{domain, fuzzer}]
  const perms = result.permutations;
  if (Array.isArray(perms) && perms.length && isObj(perms[0]) && typeof (perms[0] as Record<string, unknown>).domain === "string") {
    return <DomainPermsList items={perms as Array<Record<string, unknown>>} />;
  }
  // 5. domain/dns_a — records: { A: [...], AAAA: [...] }
  const records = result.records;
  if (isObj(records)) {
    return <DnsRecords records={records as Record<string, unknown>} />;
  }
  // 6. wayback — { first: {url, ts}, last: {url, ts} }
  if (isObj(result.first) || isObj(result.last)) {
    return <WaybackPair first={result.first} last={result.last} />;
  }
  // 7. github_search — profile: {login, name, html_url, ...}
  const profile = result.profile;
  if (isObj(profile)) {
    return <GithubProfile profile={profile as Record<string, unknown>} />;
  }
  // 8. geoip / phone / exif / whois — плоский объект, фильтруем шумные поля
  const filtered: Array<[string, unknown]> = Object.entries(result).filter(
    ([k, v]) =>
      !["ok", "found", "error", "message", "checked_total"].includes(k) &&
      v !== null &&
      v !== undefined &&
      v !== ""
  );
  if (filtered.length === 0) {
    return <span className="pretty-muted">—</span>;
  }
  return (
    <div className="pretty-object">
      {filtered.map(([k, v]) => (
        <div key={k} className="pretty-row">
          <div className="pretty-key">{prettifyKey(k)}</div>
          <div className="pretty-value">
            <PrettyAny value={v} />
          </div>
        </div>
      ))}
    </div>
  );
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function statusBadge(status: number | null): { label: string; tone: "success" | "warn" | "error" | "neutral" } | null {
  if (status === null) return null;
  if (status === 200) return { label: "OK", tone: "success" };
  if (status >= 300 && status < 400) return { label: "redir", tone: "success" };
  if (status === 404) return { label: "нет", tone: "neutral" };
  if (status === 403) return { label: "блок", tone: "warn" };
  if (status === 429) return { label: "лимит", tone: "warn" };
  if (status >= 500) return { label: "err", tone: "error" };
  if (status >= 400) return { label: "ошб", tone: "error" };
  return { label: String(status), tone: "neutral" };
}

function SitesList({ items }: { items: Array<Record<string, unknown>> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 6 }}>
      {items.map((s, i) => {
        const name = typeof s.site === "string" ? s.site : "?";
        const url = typeof s.url === "string" ? s.url : null;
        const status = typeof s.status === "number" ? s.status : null;
        const badge = statusBadge(status);
        return (
          <a
            key={i}
            href={url || "#"}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              padding: "6px 8px",
              border: "1px solid var(--border-muted)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-overlay)",
              color: "var(--text-primary)",
              textDecoration: "none",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              cursor: url ? "pointer" : "default",
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {name}
            </span>
            {badge && (
              <span
                className="status-badge"
                data-tone={badge.tone}
                style={{ height: 16, fontSize: 9, padding: "0 6px", flexShrink: 0 }}
              >
                {badge.label}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}

function DomainPermsList({ items }: { items: Array<Record<string, unknown>> }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 6 }}>
      {items.map((p, i) => {
        const dom = typeof p.domain === "string" ? p.domain : "?";
        const fuzz = typeof p.fuzzer === "string" ? p.fuzzer : null;
        return (
          <a
            key={i}
            href={`https://${dom}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "6px 8px",
              border: "1px solid var(--border-muted)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-overlay)",
              color: "var(--text-primary)",
              textDecoration: "none",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              gap: 2,
            }}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {dom}
            </span>
            {fuzz && (
              <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{fuzz}</span>
            )}
          </a>
        );
      })}
    </div>
  );
}

function ChipList({ items, kind }: { items: string[]; kind: "domain" | "text" }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {items.map((s, i) => {
        const href = kind === "domain" ? `https://${s}` : null;
        const Tag = href ? "a" : "span";
        return (
          <Tag
            key={i}
            {...(href ? { href, target: "_blank", rel: "noopener noreferrer" } : {})}
            style={{
              padding: "3px 8px",
              border: "1px solid var(--border-muted)",
              borderRadius: 999,
              background: "var(--bg-overlay)",
              color: "var(--text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              textDecoration: "none",
            }}
          >
            {s}
          </Tag>
        );
      })}
    </div>
  );
}

function DnsRecords({ records }: { records: Record<string, unknown> }) {
  const entries = Object.entries(records).filter(
    ([, v]) => Array.isArray(v) && (v as unknown[]).length > 0
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {entries.map(([type, vals]) => (
        <div key={type} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <span
            style={{
              minWidth: 50,
              fontSize: 10,
              fontWeight: 700,
              color: "var(--text-secondary)",
              fontFamily: "var(--font-mono)",
              padding: "3px 6px",
              background: "var(--bg-overlay)",
              borderRadius: "var(--radius-sm)",
              textAlign: "center",
            }}
          >
            {type}
          </span>
          <div style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-primary)" }}>
            {(vals as unknown[]).map((v, i) => (
              <div key={i}>{String(v)}</div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function WaybackPair({ first, last }: { first: unknown; last: unknown }) {
  const Snap = ({ label, snap }: { label: string; snap: unknown }) => {
    if (!isObj(snap)) return null;
    const url = typeof snap.url === "string" ? snap.url : null;
    const ts = typeof snap.ts === "string" ? snap.ts : null;
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        <span style={{ minWidth: 50, color: "var(--text-secondary)", fontWeight: 600 }}>{label}</span>
        {ts && <span style={{ color: "var(--text-muted)" }}>{ts}</span>}
        {url && (
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-primary)", textDecoration: "underline" }}>
            открыть
          </a>
        )}
      </div>
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Snap label="first" snap={first} />
      <Snap label="last" snap={last} />
    </div>
  );
}

function GithubProfile({ profile }: { profile: Record<string, unknown> }) {
  const get = (k: string) => (typeof profile[k] === "string" ? (profile[k] as string) : null);
  const num = (k: string) => (typeof profile[k] === "number" ? (profile[k] as number) : null);
  const url = get("html_url");
  const login = get("login");
  const name = get("name");
  const bio = get("bio");
  const followers = num("followers");
  const repos = num("public_repos");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: "var(--font-mono)", fontSize: 12 }}>
      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-primary)", fontWeight: 600 }}>
          @{login}
        </a>
      )}
      {name && <span style={{ color: "var(--text-primary)" }}>{name}</span>}
      {bio && <span style={{ color: "var(--text-secondary)" }}>{bio}</span>}
      {(followers !== null || repos !== null) && (
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
          {followers !== null && `${followers} followers`}
          {followers !== null && repos !== null && " · "}
          {repos !== null && `${repos} repos`}
        </span>
      )}
    </div>
  );
}

function PrettyAny({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="pretty-muted">—</span>;
  }
  if (typeof value === "string") {
    return <span className="pretty-string">{value}</span>;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="pretty-scalar">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="pretty-muted">пусто</span>;
    return (
      <div className="pretty-list">
        {value.map((item, i) => (
          <div key={i} className="pretty-list-item">
            <PrettyAny value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return (
      <div className="pretty-object">
        {entries.map(([k, v]) => (
          <div key={k} className="pretty-row">
            <div className="pretty-key">{prettifyKey(k)}</div>
            <div className="pretty-value">
              <PrettyAny value={v} />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return <span>{String(value)}</span>;
}

function prettifyKey(k: string): string {
  // user_name → User Name; firstName → First Name. Без перевода — просто читаемее.
  return k
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ─────────────────────────────────────────────
   FILE VIEW — декодированный текст файла
   ───────────────────────────────────────────── */
function FileView({
  file,
}: {
  file: { name: string | null; text: string; size: number };
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 10px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-muted)",
          borderRadius: "var(--radius-sm)",
          fontSize: 12,
          color: "var(--text-secondary)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
          {file.name || "файл"}
        </span>
        <span>{formatBytes(file.size)}</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="btn btn--ghost"
          style={{ height: 22, padding: "0 8px", fontSize: 11 }}
          onClick={() => navigator.clipboard.writeText(file.text)}
          title="Копировать содержимое"
        >
          <Copy size={12} strokeWidth={1.6} />
          <span style={{ marginLeft: 4 }}>Copy</span>
        </button>
      </div>
      <pre className="response-area" style={{ margin: 0 }}>
        {file.text}
      </pre>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/* ─────────────────────────────────────────────
   FILES VIEW — кликабельный браузер по репо
   ───────────────────────────────────────────── */
function FilesView({
  entries,
  currentRequestPath,
  onNavigate,
}: {
  entries: FileEntry[];
  currentRequestPath?: string;
  onNavigate?: (entry: FileEntry, currentRequestPath: string) => void;
}) {
  // Хлебные крошки строим из текущего request path. Пример:
  //   /repos/owner/repo/contents/src/components → ["src", "components"]
  // Наверх (в корень) ведёт ссылка на /repos/owner/repo/contents/
  const crumbs = useMemo(() => {
    if (!currentRequestPath) return null;
    const m = currentRequestPath.match(
      /^\/repos\/([^/]+)\/([^/]+)\/contents\/?(.*?)(?:\?.*)?$/
    );
    if (!m) return null;
    const [, owner, repo, rest] = m;
    const parts = rest ? rest.split("/").filter(Boolean) : [];
    return { owner, repo, parts };
  }, [currentRequestPath]);

  function navigateToCrumb(idx: number) {
    if (!crumbs || !onNavigate) return;
    const newPath = crumbs.parts.slice(0, idx + 1).join("/");
    // Создаём виртуальный entry для навигации
    const synthetic: FileEntry = {
      name: idx === -1 ? crumbs.repo : crumbs.parts[idx],
      path: newPath,
      type: "dir",
    };
    onNavigate(synthetic, currentRequestPath || "");
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {crumbs && (
        <div className="files-crumbs">
          <button
            type="button"
            className="files-crumb"
            onClick={() => navigateToCrumb(-1)}
            title={`${crumbs.owner}/${crumbs.repo}`}
          >
            {crumbs.repo}
          </button>
          {crumbs.parts.map((part, i) => (
            <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "var(--text-muted)" }}>/</span>
              <button
                type="button"
                className="files-crumb"
                onClick={() => navigateToCrumb(i)}
              >
                {part}
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="files-list">
        {entries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            className="files-entry"
            data-type={entry.type}
            onClick={() => onNavigate?.(entry, currentRequestPath || "")}
            title={entry.path}
          >
            {entry.type === "dir" ? (
              <Folder size={14} strokeWidth={1.6} className="files-entry-icon" />
            ) : (
              <FileIcon size={14} strokeWidth={1.6} className="files-entry-icon" />
            )}
            <span className="files-entry-name">{entry.name}</span>
            {entry.type === "file" && entry.size !== undefined && (
              <span className="files-entry-size">{formatBytes(entry.size)}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   MEDIA VIEW — рендер картинок/видео/аудио/PDF
   с авторизацией через Bearer-токен. Бинарь не
   умеет авторизоваться сам через <img src>,
   поэтому fetch'им как blob и отдаём object-URL.
   ───────────────────────────────────────────── */
function MediaView({
  baseURL,
  token,
  relPath,
  filename,
}: {
  baseURL: string;
  token?: string;
  relPath: string;
  filename: string;
}) {
  const meta = useMemo(() => mimeFromName(filename), [filename]);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const ac = new AbortController();
    setLoading(true);
    setErr(null);
    setBlobUrl(null);
    setSize(null);

    const full = baseURL.replace(/\/+$/, "") + relPath;
    fetch(full, {
      signal: ac.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setBlobUrl(url);
        setSize(blob.size);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled || ac.signal.aborted) return;
        setErr(e.message || String(e));
        setLoading(false);
      });

    return () => {
      cancelled = true;
      ac.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [baseURL, token, relPath]);

  function download() {
    if (!blobUrl) return;
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    a.click();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <span>{filename}</span>
        {size !== null && <span>· {formatBytes(size)}</span>}
        <span>· {meta.kind}</span>
        <div style={{ flex: 1 }} />
        {blobUrl && (
          <button
            type="button"
            className="btn btn--ghost"
            style={{ height: 24, padding: "0 8px", fontSize: 11 }}
            onClick={download}
          >
            <Download size={11} strokeWidth={1.8} />
            <span style={{ marginLeft: 4 }}>Скачать</span>
          </button>
        )}
      </div>

      {loading && <div style={{ color: "var(--text-muted)", fontSize: 12 }}>Загружаю…</div>}
      {err && (
        <div
          style={{
            color: "var(--status-high, #ff6363)",
            fontSize: 12,
            padding: 8,
            background: "var(--bg-elevated)",
            borderRadius: 6,
          }}
        >
          ❌ {err}
        </div>
      )}

      {blobUrl && meta.kind === "image" && (
        <img
          src={blobUrl}
          alt={filename}
          style={{
            maxWidth: "100%",
            borderRadius: 8,
            border: "1px solid var(--border-muted)",
            background: "var(--bg-elevated)",
          }}
        />
      )}
      {blobUrl && meta.kind === "video" && (
        <video
          src={blobUrl}
          controls
          style={{
            maxWidth: "100%",
            borderRadius: 8,
            border: "1px solid var(--border-muted)",
            background: "var(--bg-elevated)",
          }}
        />
      )}
      {blobUrl && meta.kind === "audio" && (
        <AudioPlayer src={blobUrl} />
      )}
      {blobUrl && meta.kind === "pdf" && (
        <iframe
          src={blobUrl}
          title={filename}
          style={{
            width: "100%",
            height: "70vh",
            border: "1px solid var(--border-muted)",
            borderRadius: 8,
            background: "var(--bg-elevated)",
          }}
        />
      )}
      {blobUrl && meta.kind === "text" && (
        <TextBlobView blobUrl={blobUrl} />
      )}
      {blobUrl && meta.kind === "other" && (
        <div
          style={{
            padding: 16,
            background: "var(--bg-elevated)",
            borderRadius: 8,
            border: "1px solid var(--border-muted)",
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          Этот тип файла нельзя превьюить — нажми «Скачать» сверху.
        </div>
      )}
    </div>
  );
}

function TextBlobView({ blobUrl }: { blobUrl: string }) {
  const [text, setText] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    fetch(blobUrl)
      .then((r) => r.text())
      .then((t) => {
        if (!cancelled) setText(t);
      });
    return () => {
      cancelled = true;
    };
  }, [blobUrl]);
  return (
    <pre
      className="response-area"
      style={{ margin: 0, maxHeight: "70vh", overflow: "auto" }}
    >
      {text}
    </pre>
  );
}

/* ─────────────────────────────────────────────
   AUDIO PLAYER — кастомный в нашем стиле.
   Скрытый <audio> + наша кнопка play/pause + range-slider + время.
   ───────────────────────────────────────────── */
function AudioPlayer({ src }: { src: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setTime(a.currentTime);
    const onMeta = () => setDuration(a.duration || 0);
    const onEnd = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnd);
    };
  }, [src]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play();
      setPlaying(true);
    } else {
      a.pause();
      setPlaying(false);
    }
  }

  function seek(e: React.ChangeEvent<HTMLInputElement>) {
    const a = audioRef.current;
    if (!a) return;
    const t = Number(e.target.value);
    a.currentTime = t;
    setTime(t);
  }

  const pct = duration > 0 ? (time / duration) * 100 : 0;

  return (
    <div className="audio-player">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        className="audio-player-btn"
        onClick={toggle}
        aria-label={playing ? "Пауза" : "Воспроизвести"}
      >
        {playing ? (
          <Pause size={14} strokeWidth={0} fill="currentColor" />
        ) : (
          <Play size={14} strokeWidth={0} fill="currentColor" />
        )}
      </button>
      <input
        type="range"
        className="audio-player-range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={time}
        onChange={seek}
        style={{ ["--pct" as string]: `${pct}%` }}
      />
      <span className="audio-player-time">
        {fmtTime(time)} / {fmtTime(duration)}
      </span>
    </div>
  );
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/* ─────────────────────────────────────────────
   MEDIA LIST — карточки всех файлов из ответа
   /media list. Аудио — мини-плеер inline,
   image — превью, остальное — кнопка Open/Скачать.
   ───────────────────────────────────────────── */
function MediaListView({
  baseURL,
  token,
  items,
}: {
  baseURL: string;
  token?: string;
  items: { kind: string; filename: string; relPath: string; size?: number }[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <div className="media-list">
      {items.map((it) => {
        const meta = mimeFromName(it.filename);
        const isOpen = expanded === it.relPath;
        return (
          <div key={it.relPath} className="media-list-item">
            <div className="media-list-row">
              <span className="media-list-kind" data-kind={it.kind}>{it.kind}</span>
              <span className="media-list-name" title={it.filename}>{it.filename}</span>
              <span className="media-list-size">
                {it.size != null ? formatBytes(it.size) : ""}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                style={{ height: 24, padding: "0 8px", fontSize: 11 }}
                onClick={() => setExpanded(isOpen ? null : it.relPath)}
              >
                {isOpen ? "Закрыть" : "Открыть"}
              </button>
            </div>
            {isOpen && (
              <div style={{ marginTop: 8 }}>
                <MediaView
                  baseURL={baseURL}
                  token={token}
                  relPath={it.relPath}
                  filename={it.filename}
                />
              </div>
            )}
            {!isOpen && meta.kind === "audio" && (
              <div style={{ marginTop: 6 }}>
                <InlineAudio baseURL={baseURL} token={token} relPath={it.relPath} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Авто-загруженный мини-плеер для аудио — без кнопки «открыть». */
function InlineAudio({
  baseURL,
  token,
  relPath,
}: {
  baseURL: string;
  token?: string;
  relPath: string;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    const ac = new AbortController();
    const full = baseURL.replace(/\/+$/, "") + relPath;
    fetch(full, {
      signal: ac.signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then((r) => r.blob())
      .then((b) => {
        if (cancelled) return;
        url = URL.createObjectURL(b);
        setBlobUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      ac.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [baseURL, token, relPath]);
  if (!blobUrl) return null;
  return <AudioPlayer src={blobUrl} />;
}
