import { useEffect, useId, useRef, useState } from "react";
import { MoreVertical } from "lucide-react";

export interface ActionsMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
}

/**
 * Кебаб-меню (троеточие) → поповер с действиями. Использует те же CSS-классы
 * что и Dropdown — `.dropdown-menu` / `.dropdown-option`. Без логики выбора:
 * каждый item это action с onClick.
 */
export function ActionsMenu({
  items,
  ariaLabel = "Действия",
}: {
  items: ActionsMenuItem[];
  ariaLabel?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      top: r.bottom + 4,
      left: Math.max(8, r.right - 200),
      width: 200,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (
        !triggerRef.current?.contains(t) &&
        !menuRef.current?.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <MoreVertical size={16} strokeWidth={2} />
      </button>
      {open && pos && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          className="dropdown-menu"
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: pos.width,
            minWidth: pos.width,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((it, i) => (
            <div
              key={i}
              role="menuitem"
              tabIndex={-1}
              className="dropdown-option"
              data-danger={it.danger ? true : undefined}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
              style={
                it.danger
                  ? { color: "var(--status-high, #f85149)" }
                  : undefined
              }
            >
              {it.icon ? (
                <span style={{ display: "inline-flex", marginRight: 8 }}>
                  {it.icon}
                </span>
              ) : null}
              {it.label}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
