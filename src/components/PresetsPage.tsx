import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  Pencil,
  Trash2,
  LayoutGrid,
  X,
  Check,
  Zap,
  ChevronRight,
  Upload,
  Copy,
} from "lucide-react";
import { useAPIs } from "../context/APIs";
import {
  PRESET_CATEGORIES,
  type APIPreset,
  type PresetCategory,
  type PresetEndpoint,
} from "../lib/presets";
import type { AuthKind } from "../lib/storage";
import { uid } from "../lib/storage";
import { Dropdown } from "./Dropdown";
import { ActionsMenu } from "./ActionsMenu";

const METHODS: PresetEndpoint["method"][] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function emptyPreset(): APIPreset {
  return {
    id: uid(),
    name: "",
    emoji: "",
    category: "Свои",
    baseURL: "",
    auth: { kind: "bearer" },
    defaultHeaders: [],
    endpoints: [],
    note: "",
  };
}

export function PresetsPage() {
  const {
    userPresets,
    saveUserPreset,
    removeUserPreset,
    seedPresets,
    removeSeedPreset,
    saveSeedPreset,
    addAPI,
    setView,
  } = useAPIs();
  const [editing, setEditing] = useState<APIPreset | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [importFlash, setImportFlash] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [manualCopy, setManualCopy] = useState<{ text: string; label: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  function stripSecrets<T>(obj: T): T {
    // Удаляем auth.token из любого пресета или массива пресетов перед экспортом —
    // секреты не должны улетать в JSON который копируешь / шаришь.
    if (Array.isArray(obj)) return obj.map((x) => stripSecrets(x)) as unknown as T;
    if (obj && typeof obj === "object") {
      const o = { ...(obj as Record<string, unknown>) };
      if (o.auth && typeof o.auth === "object") {
        const auth = { ...(o.auth as Record<string, unknown>) };
        delete auth.token;
        o.auth = auth;
      }
      if (Array.isArray(o.presets)) o.presets = stripSecrets(o.presets);
      return o as unknown as T;
    }
    return obj;
  }

  function copyToClipboard(data: unknown, label: string) {
    const text = JSON.stringify(stripSecrets(data), null, 2);
    // Синхронный fallback через execCommand — для случаев когда iOS PWA
    // отдаёт `clipboard.writeText` в reject (потеря user-gesture после
    // dropdown-анимации). Сначала пробуем синхронный path, потом async API.
    const tryExecCommand = (): boolean => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "0";
      ta.style.left = "0";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      document.body.removeChild(ta);
      return ok;
    };

    if (tryExecCommand()) {
      flashImport(`Скопировано: ${label}`);
      return;
    }

    // Async clipboard API как второй шанс (часть iOS Safari в PWA её одобрит).
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(text)
        .then(() => flashImport(`Скопировано: ${label}`))
        .catch(() => {
          // Полный fail — открываем диалог где юзер сам скопирует руками.
          setManualCopy({ text, label });
        });
      return;
    }
    setManualCopy({ text, label });
  }

  function exportOne(p: APIPreset) {
    void copyToClipboard(p, `«${p.name}»`);
  }

  function exportAll() {
    void copyToClipboard(
      {
        kind: "veni-presets",
        version: 1,
        exportedAt: new Date().toISOString(),
        presets: userPresets,
      },
      "Все пресеты"
    );
  }

  function normalizeJsonText(raw: string): string {
    // Чистим от iOS-смарт-кавычек, ёлочек, NBSP, BOM.
    return raw
      .replace(/^﻿/, "")
      .replace(/[“”«»]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/ /g, " ")
      .trim();
  }

  function importFromText(text: string): { added: number; error?: string } {
    try {
      const parsed = JSON.parse(normalizeJsonText(text)) as
        | APIPreset
        | APIPreset[]
        | { presets?: APIPreset[] };
      const list: APIPreset[] = Array.isArray(parsed)
        ? parsed
        : "presets" in parsed && Array.isArray(parsed.presets)
          ? parsed.presets
          : [parsed as APIPreset];
      let added = 0;
      for (const p of list) {
        if (!p || typeof p.id !== "string" || typeof p.baseURL !== "string") {
          continue;
        }
        // Если импортируем поверх существующего пресета (тот же id) и в
        // импортируемом JSON нет токена (он вырезан при экспорте) — сохраняем
        // локальный токен. Иначе round-trip теряет токен.
        const existing = userPresets.find((x) => x.id === p.id);
        const auth = {
          ...p.auth,
          token: p.auth?.token ?? existing?.auth?.token,
        };
        saveUserPreset({
          ...p,
          auth,
          endpoints: Array.isArray(p.endpoints) ? p.endpoints : [],
          defaultHeaders: Array.isArray(p.defaultHeaders)
            ? p.defaultHeaders
            : [],
        });
        added += 1;
      }
      return { added };
    } catch (e) {
      return { added: 0, error: (e as Error).message };
    }
  }

  function flashImport(msg: string) {
    setImportFlash(msg);
    setTimeout(() => setImportFlash(null), 3500);
  }

  async function handleImportFile(file: File) {
    const text = await file.text();
    const r = importFromText(text);
    flashImport(
      r.error
        ? `Ошибка JSON: ${r.error}`
        : r.added > 0
          ? `Импортировано: ${r.added}`
          : "Валидных пресетов в файле нет"
    );
  }

  function applyPreset(p: APIPreset) {
    addAPI({
      name: p.name || "Без имени",
      baseURL: p.baseURL.replace(/\/+$/, ""),
      auth: {
        kind: p.auth.kind,
        headerName: p.auth.headerName,
        queryName: p.auth.queryName,
        token: p.auth.kind === "none" ? undefined : p.auth.token,
      },
      defaultHeaders: p.defaultHeaders ?? [],
      endpoints: p.endpoints,
      endpointCategories: p.endpointCategories,
      presetId: p.id,
    });
    setView("workspace");
  }

  return (
    <div className="page">
      <div className="page-header-row">
        <h1 className="page-title">Пресеты</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleImportFile(f);
              e.target.value = ""; // позволяет повторно выбрать тот же файл
            }}
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setImportOpen(true)}
            title="Импорт пресетов: вставить JSON или выбрать файл"
          >
            <Upload size={14} strokeWidth={1.8} />
            <span>Импорт</span>
          </button>
          {userPresets.length > 0 && (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={exportAll}
              title="Скопировать все свои пресеты в буфер"
            >
              <Copy size={14} strokeWidth={1.8} />
              <span>Экспорт</span>
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setEditing(emptyPreset())}
          >
            <Plus size={14} strokeWidth={2} />
            <span>Создать пресет</span>
          </button>
        </div>
      </div>
      <div className="page-body">
        {userPresets.length === 0 && seedPresets.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <LayoutGrid size={22} strokeWidth={1.5} />
            </div>
            <h2>Пресетов пока нет</h2>
            <p>
              Жми «Создать пресет» — собери своё API: имя, базовый URL, тип
              авторизации и список действий.
            </p>
          </div>
        ) : (
          <div className="preset-cards">
            {userPresets.map((p) => {
              const confirming = confirmingId === p.id;
              return (
                <PresetCard
                  key={p.id}
                  preset={p}
                  onApply={() => applyPreset(p)}
                  actions={
                    <ActionsMenu
                      items={[
                        {
                          key: "copy",
                          label: "Скопировать",
                          icon: <Copy size={13} strokeWidth={1.6} />,
                          onClick: () => exportOne(p),
                        },
                        {
                          key: "edit",
                          label: "Редактировать",
                          icon: <Pencil size={13} strokeWidth={1.6} />,
                          onClick: () => setEditing(p),
                        },
                        {
                          key: "delete",
                          label: confirming ? "Точно удалить?" : "Удалить",
                          icon: <Trash2 size={13} strokeWidth={1.6} />,
                          danger: true,
                          onClick: () => {
                            if (confirming) {
                              removeUserPreset(p.id);
                              setConfirmingId(null);
                            } else {
                              setConfirmingId(p.id);
                              setTimeout(() => setConfirmingId(null), 2500);
                            }
                          },
                        },
                      ]}
                    />
                  }
                />
              );
            })}
            {seedPresets.map((p) => {
              const confirming = confirmingId === p.id;
              return (
                <PresetCard
                  key={p.id}
                  preset={p}
                  onApply={() => applyPreset(p)}
                  source="claude"
                  sourceTag="Claude"
                  actions={
                    <ActionsMenu
                      items={[
                        {
                          key: "copy",
                          label: "Скопировать",
                          icon: <Copy size={13} strokeWidth={1.6} />,
                          onClick: () => exportOne(p),
                        },
                        {
                          key: "edit",
                          label: "Редактировать",
                          icon: <Pencil size={13} strokeWidth={1.6} />,
                          onClick: () => setEditing(p),
                        },
                        {
                          key: "delete",
                          label: confirming ? "Точно удалить?" : "Удалить",
                          icon: <Trash2 size={13} strokeWidth={1.6} />,
                          danger: true,
                          onClick: () => {
                            if (confirming) {
                              void removeSeedPreset(p.id);
                              setConfirmingId(null);
                            } else {
                              setConfirmingId(p.id);
                              setTimeout(() => setConfirmingId(null), 2500);
                            }
                          },
                        },
                      ]}
                    />
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      <PresetModal
        open={editing !== null}
        preset={editing}
        onClose={() => setEditing(null)}
        onSave={(p) => {
          // Route to the right store: seed-preset (Claude/file) vs user (localStorage).
          const isSeed = seedPresets.some((s) => s.id === p.id);
          if (isSeed) void saveSeedPreset(p);
          else saveUserPreset(p);
          setEditing(null);
        }}
      />
      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onPickFile={() => importInputRef.current?.click()}
        onImportText={(text) => {
          const r = importFromText(text);
          flashImport(
            r.error
              ? `Ошибка JSON: ${r.error}`
              : r.added > 0
                ? `Импортировано: ${r.added}`
                : "Валидных пресетов нет"
          );
          if (!r.error && r.added > 0) setImportOpen(false);
        }}
      />
      <ManualCopyModal
        data={manualCopy}
        onClose={() => setManualCopy(null)}
      />
      {importFlash && <Toast message={importFlash} />}
    </div>
  );
}

/* ─── Compact toast — фикс снизу (mobile) / сверху (desktop) ─── */
function Toast({ message }: { message: string }) {
  return (
    <div className="veni-toast" role="status" aria-live="polite">
      <Check size={14} strokeWidth={2.2} />
      <span>{message}</span>
    </div>
  );
}

/* ─── Fallback: ручное копирование когда clipboard API закрыт (iOS PWA) ─── */
function ManualCopyModal({
  data,
  onClose,
}: {
  data: { text: string; label: string } | null;
  onClose: () => void;
}) {
  if (!data) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h2 className="modal-title">Копирование</h2>
        </div>
        <div className="modal-body">
          <p style={{ marginBottom: 12, color: "var(--text-secondary)", fontSize: 13 }}>
            Браузер не дал автоматически положить текст в буфер. Выдели всё и
            нажми «Копировать» руками (Cmd/Ctrl+A → Cmd/Ctrl+C).
          </p>
          <textarea
            className="body-textarea"
            style={{ minHeight: 200, fontFamily: "var(--font-mono)" }}
            value={data.text}
            readOnly
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="none"
            autoComplete="off"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn--primary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Import modal: file picker OR paste-text ─────────── */
function ImportModal({
  open,
  onClose,
  onPickFile,
  onImportText,
}: {
  open: boolean;
  onClose: () => void;
  onPickFile: () => void;
  onImportText: (text: string) => void;
}) {
  const [text, setText] = useState("");
  useEffect(() => {
    if (!open) setText("");
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        style={{ maxWidth: 560, display: "flex", flexDirection: "column" }}
      >
        <div className="modal-header">
          <h2>Импорт пресетов</h2>
          <p>
            Вставь JSON ниже или выбери файл. Принимается один пресет, массив
            или объект с полем <code>presets</code>.
          </p>
        </div>
        <div className="modal-body">
          <textarea
            className="body-textarea"
            style={{ minHeight: 220, fontFamily: "var(--font-mono)" }}
            placeholder='{"id":"...","name":"...","baseURL":"https://..."}'
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="none"
            autoComplete="off"
            inputMode="text"
            autoFocus
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" onClick={onPickFile}>
            <Upload size={14} strokeWidth={1.8} />
            <span>Из файла</span>
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Отмена
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!text.trim()}
            onClick={() => onImportText(text)}
          >
            Импортировать
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Preset card (used for both user & seed presets) ─────────────── */
function PresetCard({
  preset,
  onApply,
  actions,
  source,
  sourceTag,
}: {
  preset: APIPreset;
  onApply: () => void;
  actions?: React.ReactNode;
  source?: string;
  sourceTag?: string;
}) {
  const hasToken = !!preset.auth.token;
  const tokenWarn = preset.auth.kind !== "none" && !hasToken;
  return (
    <div className="preset-card" data-source={source}>
      <div className="preset-card-main">
        <div className="preset-card-name">
          {preset.name || "Без имени"}
          {sourceTag && <span className="preset-source-tag">{sourceTag}</span>}
          {tokenWarn && (
            <span className="preset-source-tag" data-warn="true">
              нет токена
            </span>
          )}
        </div>
        <div className="preset-card-meta">
          {preset.baseURL.replace(/^https?:\/\//, "")} · {preset.endpoints.length}{" "}
          {endpointsWord(preset.endpoints.length)}
        </div>
      </div>
      <button
        type="button"
        className="icon-btn"
        title={
          tokenWarn
            ? "Применить (без токена — открой Edit и впиши)"
            : "Применить как API-таб"
        }
        onClick={onApply}
      >
        <Zap size={14} strokeWidth={1.6} />
      </button>
      {actions}
    </div>
  );
}

function endpointsWord(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return "действий";
  if (mod10 === 1) return "действие";
  if (mod10 >= 2 && mod10 <= 4) return "действия";
  return "действий";
}

/* ─────────────────────────────────────────────
   MODAL — same vibe as AddAPIModal
   ───────────────────────────────────────────── */
function PresetModal({
  open,
  preset,
  onClose,
  onSave,
}: {
  open: boolean;
  preset: APIPreset | null;
  onClose: () => void;
  onSave: (p: APIPreset) => void;
}) {
  const [draft, setDraft] = useState<APIPreset>(preset ?? emptyPreset());
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const isNew = !preset?.name;

  useEffect(() => {
    if (open) {
      setDraft(preset ?? emptyPreset());
      setTimeout(() => firstFieldRef.current?.focus(), 50);
    }
  }, [open, preset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const update = (patch: Partial<APIPreset>) => setDraft((d) => ({ ...d, ...patch }));
  const updateAuth = (patch: Partial<APIPreset["auth"]>) =>
    setDraft((d) => ({ ...d, auth: { ...d.auth, ...patch } }));

  const canSave =
    draft.name.trim().length > 0 && /^https?:\/\//i.test(draft.baseURL.trim());

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    const cleanEndpoints = draft.endpoints.filter(
      (ep) => ep.path.trim() && ep.label.trim()
    );
    // Preserve category order — even for empty categories the user just created.
    const cats = draft.endpointCategories ?? [];
    const seen = new Set<string>();
    const orderedCats: string[] = [];
    for (const c of cats) {
      const t = c.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        orderedCats.push(t);
      }
    }
    for (const ep of cleanEndpoints) {
      const c = ep.category?.trim();
      if (c && !seen.has(c)) {
        seen.add(c);
        orderedCats.push(c);
      }
    }
    onSave({
      ...draft,
      name: draft.name.trim(),
      baseURL: draft.baseURL.trim().replace(/\/+$/, ""),
      defaultHeaders: (draft.defaultHeaders ?? []).filter((h) => h.key.trim()),
      endpoints: cleanEndpoints,
      endpointCategories: orderedCats.length > 0 ? orderedCats : undefined,
      note: draft.note?.trim() || undefined,
    });
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preset-modal-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="modal"
        onSubmit={handleSubmit}
        style={{ maxWidth: 520, maxHeight: "calc(100svh - 40px)", display: "flex", flexDirection: "column" }}
      >
        <div className="modal-header">
          <h2 id="preset-modal-title">{isNew ? "Новый пресет" : "Редактировать пресет"}</h2>
          <p>Шаблон API: имя, base URL, авторизация и список действий.</p>
        </div>
        <div className="modal-body" style={{ overflowY: "auto" }}>
          <div className="field">
            <label className="field-label" htmlFor="preset-name">Название</label>
            <input
              id="preset-name"
              ref={firstFieldRef}
              className="field-input"
              value={draft.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="Например: Мой backend"
              autoComplete="off"
            />
          </div>

          <div className="field">
            <label className="field-label">Категория</label>
            <Dropdown<PresetCategory>
              ariaLabel="Категория"
              value={draft.category}
              onChange={(v) => update({ category: v })}
              options={PRESET_CATEGORIES.map((c) => ({ value: c, label: c }))}
            />
          </div>

          <div className="field">
            <label className="field-label" htmlFor="preset-base">Base URL</label>
            <input
              id="preset-base"
              className="field-input"
              value={draft.baseURL}
              onChange={(e) => update({ baseURL: e.target.value })}
              placeholder="https://api.example.com"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="field">
            <label className="field-label">Авторизация</label>
            <Dropdown<AuthKind>
              ariaLabel="Авторизация"
              value={draft.auth.kind}
              onChange={(v) => updateAuth({ kind: v })}
              options={[
                { value: "none", label: "Без авторизации" },
                { value: "bearer", label: "Bearer Token (Authorization)" },
                { value: "header", label: "Custom header" },
                { value: "query", label: "Query parameter" },
              ]}
            />
          </div>

          {draft.auth.kind === "header" && (
            <div className="field">
              <label className="field-label" htmlFor="preset-hname">Header name</label>
              <input
                id="preset-hname"
                className="field-input"
                value={draft.auth.headerName ?? ""}
                onChange={(e) => updateAuth({ headerName: e.target.value })}
                placeholder="X-API-Key"
              />
            </div>
          )}

          {draft.auth.kind === "query" && (
            <div className="field">
              <label className="field-label" htmlFor="preset-qname">Query name</label>
              <input
                id="preset-qname"
                className="field-input"
                value={draft.auth.queryName ?? ""}
                onChange={(e) => updateAuth({ queryName: e.target.value })}
                placeholder="api_key"
              />
            </div>
          )}

          {draft.auth.kind !== "none" && (
            <div className="field">
              <label className="field-label" htmlFor="preset-token">
                Токен
              </label>
              <input
                id="preset-token"
                className="field-input"
                type="password"
                placeholder="ghp_••••, sk-••••, и т.п."
                value={draft.auth.token ?? ""}
                onChange={(e) => updateAuth({ token: e.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="field-helper" style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4, display: "block" }}>
                Хранится локально. При экспорте в JSON автоматически вырезается.
              </span>
            </div>
          )}

          <div className="field">
            <label className="field-label" htmlFor="preset-note">Подсказка (необязательно)</label>
            <textarea
              id="preset-note"
              className="field-input"
              style={{ minHeight: 64, height: "auto", padding: "8px 12px", fontFamily: "var(--font-sans)", resize: "vertical" }}
              value={draft.note ?? ""}
              onChange={(e) => update({ note: e.target.value })}
              placeholder="Например: ключ нужно вставить как 'OAuth <твой_ключ>'"
              spellCheck={false}
            />
          </div>

          <HeadersEditor
            rows={draft.defaultHeaders ?? []}
            onChange={(rows) => update({ defaultHeaders: rows })}
          />

          <EndpointsEditor
            rows={draft.endpoints}
            categories={draft.endpointCategories ?? []}
            onChange={(rows, cats) =>
              update({ endpoints: rows, endpointCategories: cats })
            }
          />
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn btn--primary" disabled={!canSave}>
            {isNew ? "Создать" : "Сохранить"}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ─── Headers editor ─────────────────────────────────── */
function HeadersEditor({
  rows,
  onChange,
}: {
  rows: Array<{ key: string; value: string }>;
  onChange: (r: Array<{ key: string; value: string }>) => void;
}) {
  return (
    <div className="section">
      <div className="section-label">
        <span>Дефолтные заголовки</span>
        <button
          type="button"
          className="btn btn--ghost"
          style={{ height: 24, padding: "0 8px", fontSize: 11 }}
          onClick={() => onChange([...rows, { key: "", value: "" }])}
        >
          <Plus size={11} strokeWidth={2} />
          <span style={{ marginLeft: 2 }}>Добавить</span>
        </button>
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "6px 0" }}>
          —
        </div>
      ) : (
        rows.map((row, i) => (
          <div key={i} className="kv-row">
            <input
              className="kv-input"
              value={row.key}
              placeholder="header"
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
              placeholder="value"
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
              <X size={12} strokeWidth={1.6} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}

/* ─── Endpoints editor ───────────────────────────────── */
const UNCAT = "Без категории";

function EndpointsEditor({
  rows,
  categories,
  onChange,
}: {
  rows: PresetEndpoint[];
  categories: string[];
  onChange: (rows: PresetEndpoint[], cats: string[]) => void;
}) {
  // Build display order: explicit categories first, then any categories that exist
  // only on endpoints. UNCAT shown only if there are uncategorised endpoints.
  const displayCats = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of categories) {
      const t = c.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    for (const r of rows) {
      const c = r.category?.trim();
      if (c && !seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
    if (rows.some((r) => !r.category?.trim())) out.push(UNCAT);
    return out;
  }, [rows, categories]);

  const grouped = useMemo<Array<[string, PresetEndpoint[]]>>(() => {
    const map = new Map<string, PresetEndpoint[]>();
    for (const cat of displayCats) map.set(cat, []);
    for (const r of rows) {
      const cat = r.category?.trim() || UNCAT;
      const arr = map.get(cat) ?? [];
      arr.push(r);
      map.set(cat, arr);
    }
    return Array.from(map.entries());
  }, [rows, displayCats]);

  function addCategory() {
    const name = `Категория ${categories.length + 1}`;
    onChange(rows, [...categories, name]);
  }

  function renameCategory(oldName: string, newName: string) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const nextRows = rows.map((r) =>
      r.category === oldName ? { ...r, category: trimmed } : r
    );
    const nextCats = categories.map((c) => (c === oldName ? trimmed : c));
    onChange(nextRows, nextCats);
  }

  function removeCategory(name: string) {
    if (name === UNCAT) {
      onChange(
        rows.filter((r) => r.category?.trim()),
        categories
      );
      return;
    }
    onChange(
      rows.filter((r) => r.category !== name),
      categories.filter((c) => c !== name)
    );
  }

  function addEndpoint(category: string) {
    const cat = category === UNCAT ? undefined : category;
    onChange(
      [...rows, { method: "GET", path: "/", label: "", category: cat }],
      categories
    );
  }

  function patchEndpointAt(globalIdx: number, patch: Partial<PresetEndpoint>) {
    const next = rows.slice();
    next[globalIdx] = { ...next[globalIdx], ...patch };
    onChange(next, categories);
  }

  function removeEndpointAt(globalIdx: number) {
    onChange(
      rows.filter((_, i) => i !== globalIdx),
      categories
    );
  }

  return (
    <div className="section">
      <div className="section-label">
        <span>Действия по категориям</span>
        <button
          type="button"
          className="btn btn--ghost"
          style={{ height: 24, padding: "0 8px", fontSize: 11 }}
          onClick={addCategory}
        >
          <Plus size={11} strokeWidth={2} />
          <span style={{ marginLeft: 2 }}>Добавить категорию</span>
        </button>
      </div>

      {grouped.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "6px 0" }}>
          Нет категорий — нажми «Добавить категорию» сверху
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {grouped.map(([cat, items]) => (
            <CategorySection
              key={cat}
              name={cat}
              items={items}
              onRename={(newName) => renameCategory(cat, newName)}
              onRemove={() => removeCategory(cat)}
              onAddEndpoint={() => addEndpoint(cat)}
              onPatch={(epIdx, patch) => {
                const globalIdx = rows.indexOf(items[epIdx]);
                if (globalIdx !== -1) patchEndpointAt(globalIdx, patch);
              }}
              onRemoveEndpoint={(epIdx) => {
                const globalIdx = rows.indexOf(items[epIdx]);
                if (globalIdx !== -1) removeEndpointAt(globalIdx);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CategorySection({
  name,
  items,
  onRename,
  onRemove,
  onAddEndpoint,
  onPatch,
  onRemoveEndpoint,
}: {
  name: string;
  items: PresetEndpoint[];
  onRename: (newName: string) => void;
  onRemove: () => void;
  onAddEndpoint: () => void;
  onPatch: (idx: number, patch: Partial<PresetEndpoint>) => void;
  onRemoveEndpoint: (idx: number) => void;
}) {
  const [open, setOpen] = useState(true);
  const isUncat = name === UNCAT;
  const [draftName, setDraftName] = useState(name);
  useEffect(() => setDraftName(name), [name]);

  return (
    <div
      style={{
        border: "1px solid var(--border-muted)",
        borderRadius: "var(--radius-md)",
        background: "var(--bg-surface)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 8px",
          borderBottom: open ? "1px solid var(--border-muted)" : "none",
        }}
      >
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          style={{ width: 24, height: 24 }}
        >
          <ChevronRight
            size={12}
            strokeWidth={2}
            className="preset-category-chevron"
            data-open={open}
          />
        </button>
        {isUncat ? (
          <span
            style={{
              flex: 1,
              fontSize: 12,
              color: "var(--text-muted)",
              fontStyle: "italic",
            }}
          >
            {name}
          </span>
        ) : (
          <input
            className="kv-input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => onRename(draftName)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
              if (e.key === "Escape") setDraftName(name);
            }}
            style={{ flex: 1, fontWeight: 600 }}
            placeholder="Имя категории"
          />
        )}
        <span
          className="preset-category-count"
          style={{ height: 20, minWidth: 24 }}
        >
          {items.length}
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Добавить действие"
          onClick={onAddEndpoint}
        >
          <Plus size={12} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title={
            isUncat
              ? "Удалить все действия без категории"
              : "Удалить категорию"
          }
          onClick={onRemove}
        >
          <Trash2 size={12} strokeWidth={1.6} />
        </button>
      </div>
      {open && (
        <div
          style={{
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {items.length === 0 ? (
            <div
              style={{
                fontSize: 12,
                color: "var(--text-muted)",
                padding: "4px 0",
              }}
            >
              Пусто — нажми «+» в шапке чтобы добавить действие
            </div>
          ) : (
            items.map((ep, i) => (
              <EndpointRow
                key={i}
                ep={ep}
                onPatch={(patch) => onPatch(i, patch)}
                onRemove={() => onRemoveEndpoint(i)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function EndpointRow({
  ep,
  onPatch,
  onRemove,
}: {
  ep: PresetEndpoint;
  onPatch: (patch: Partial<PresetEndpoint>) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "92px 1fr 1.4fr 90px 28px",
        gap: 6,
        alignItems: "center",
      }}
    >
      <Dropdown<PresetEndpoint["method"]>
        className="kv-input"
        ariaLabel="HTTP method"
        value={ep.method}
        onChange={(m) => onPatch({ method: m })}
        triggerStyle={{
          fontWeight: 700,
          color: `var(--method-${ep.method.toLowerCase()})`,
        }}
        options={METHODS.map((m) => ({
          value: m,
          label: m,
          color: `var(--method-${m.toLowerCase()})`,
        }))}
      />
      <input
        className="kv-input"
        value={ep.path}
        placeholder="/users/me"
        spellCheck={false}
        onChange={(e) => onPatch({ path: e.target.value })}
      />
      <input
        className="kv-input"
        value={ep.label}
        placeholder="Что делает"
        onChange={(e) => onPatch({ label: e.target.value })}
      />
      <Dropdown<string>
        className="kv-input"
        ariaLabel="Статус"
        value={ep.status ?? ""}
        onChange={(s) =>
          onPatch({ status: (s || undefined) as PresetEndpoint["status"] })
        }
        options={[
          { value: "", label: "—" },
          { value: "ready", label: "RDY" },
          { value: "soon", label: "SOON" },
          { value: "wip", label: "WIP" },
          { value: "broken", label: "ERR" },
        ]}
      />
      <button
        type="button"
        className="kv-remove"
        aria-label="Remove"
        onClick={onRemove}
      >
        <X size={12} strokeWidth={1.6} />
      </button>
    </div>
  );
}

// Old flat editor (kept around as reference, no longer used).
