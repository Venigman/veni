import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

export interface DropdownOption<T extends string = string> {
  value: T;
  label: string;
  /** Optional inline color for option label (e.g. method colors). */
  color?: string;
  /** Декоративная иконка слева от лейбла. */
  icon?: React.ReactNode;
  /** Маркирует пункт как деструктивный (красный). */
  danger?: boolean;
}

interface Props<T extends string = string> {
  value: T;
  onChange: (next: T) => void;
  options: DropdownOption<T>[];
  /** Reuses .field-input / .kv-input / .method-select sizing for the trigger. */
  className?: string;
  /** Forwarded to the trigger button. */
  ariaLabel?: string;
  /** Forwarded to the trigger button (data-* etc). */
  triggerProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  /** Inline style override for the trigger (e.g. method color). */
  triggerStyle?: React.CSSProperties;
  /** Width strategy for the open menu. "trigger" = same width as button (default). "auto" = content width. */
  menuWidth?: "trigger" | "auto";
  /**
   * Кастомное содержимое триггер-кнопки (например иконка ⋮ для actions-меню).
   * Если не задано — показываем `current.label` как обычный select.
   */
  triggerContent?: React.ReactNode;
  /**
   * "menu" → каждый option это действие, value не обновляется визуально, onChange
   * вызывается и меню закрывается. "select" (default) — обычный селект.
   */
  mode?: "select" | "menu";
}

/**
 * Themed dropdown — replaces native <select> so the OPEN list inherits app
 * styling (dark surface, our borders, hover, focus ring). Behaves like a select
 * for keyboard users: Enter/Space/ArrowDown opens, Up/Down navigate, Enter
 * commits, Esc closes.
 */
export function Dropdown<T extends string = string>({
  value,
  onChange,
  options,
  className = "field-input",
  ariaLabel,
  triggerProps,
  triggerStyle,
  menuWidth = "trigger",
  triggerContent,
  mode = "select",
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value)
    )
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const current = options.find((o) => o.value === value);

  // Reset highlight to current value whenever menu opens.
  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setHighlight(idx === -1 ? 0 : idx);
      // Focus the menu so arrow keys / Enter route to onMenuKey
      requestAnimationFrame(() => menuRef.current?.focus());
    }
  }, [open, value, options]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (
        triggerRef.current?.contains(t) ||
        menuRef.current?.contains(t)
      ) {
        return;
      }
      setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Close on Esc / scroll / resize. Closing on scroll keeps the menu glued to
  // the trigger — better than letting it drift when a modal body scrolls.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onScroll = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // Position the menu in the viewport (fixed) so it isn't clipped by modal
  // bodies with overflow:auto and so it can flip up if there's no room below.
  const [menuPos, setMenuPos] = useState<{
    top: number;
    left: number;
    width?: number;
    placement: "below" | "above";
  } | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placement: "below" | "above" =
      spaceBelow < 220 && spaceAbove > spaceBelow ? "above" : "below";

    // Считаем left так, чтобы меню всегда помещалось в окне.
    const vw = window.innerWidth;
    const margin = 8;
    // Ожидаемая ширина меню (для menuWidth=trigger — как у триггера, для auto — fallback ~180).
    const expectedWidth = menuWidth === "trigger" ? rect.width : 180;
    let left = mode === "menu"
      ? rect.right - expectedWidth // выравниваем по правому краю триггера
      : rect.left;
    // Не вылезаем за правый край.
    if (left + expectedWidth > vw - margin) left = vw - expectedWidth - margin;
    // И за левый.
    if (left < margin) left = margin;

    setMenuPos({
      top: placement === "below" ? rect.bottom + 4 : rect.top - 4,
      left,
      width: menuWidth === "trigger" ? rect.width : undefined,
      placement,
    });
  }, [open, menuWidth, mode]);

  function commit(idx: number) {
    const opt = options[idx];
    if (!opt) return;
    if (opt.value !== value) onChange(opt.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " " || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  }

  function onMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(highlight);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "Home") {
      e.preventDefault();
      setHighlight(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setHighlight(options.length - 1);
    }
  }

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={`${className}${triggerContent ? "" : " dropdown-trigger"}`}
        aria-haspopup={mode === "menu" ? "menu" : "listbox"}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        onClick={(e) => {
          if (mode === "menu") e.stopPropagation();
          setOpen((v) => !v);
        }}
        onKeyDown={onTriggerKey}
        style={triggerStyle}
        {...triggerProps}
      >
        {triggerContent ?? (
          <span className="dropdown-value">{current?.label ?? ""}</span>
        )}
      </button>

      {open && menuPos && (
        <div
          id={menuId}
          ref={menuRef}
          role="listbox"
          tabIndex={-1}
          className="dropdown-menu"
          data-placement={menuPos.placement}
          onKeyDown={onMenuKey}
          style={{
            position: "fixed",
            top: menuPos.placement === "below" ? menuPos.top : undefined,
            bottom:
              menuPos.placement === "above"
                ? window.innerHeight - menuPos.top
                : undefined,
            left: menuPos.left,
            width: menuPos.width,
            minWidth: menuPos.width,
          }}
        >
          {options.map((opt, idx) => (
            <div
              key={opt.value}
              role={mode === "menu" ? "menuitem" : "option"}
              aria-selected={mode === "select" ? opt.value === value : undefined}
              data-highlighted={idx === highlight}
              data-danger={opt.danger ? true : undefined}
              className="dropdown-option"
              style={
                opt.danger
                  ? { color: "var(--status-high, #f85149)" }
                  : opt.color
                    ? { color: opt.color, fontWeight: 700 }
                    : undefined
              }
              onMouseEnter={() => setHighlight(idx)}
              onMouseDown={(e) => {
                // mousedown so click registers before outside-click handler
                e.preventDefault();
                commit(idx);
              }}
            >
              {opt.icon ? (
                <span style={{ display: "inline-flex", marginRight: 8, opacity: 0.85 }}>
                  {opt.icon}
                </span>
              ) : null}
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
