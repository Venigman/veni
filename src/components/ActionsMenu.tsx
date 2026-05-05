import { MoreVertical } from "lucide-react";
import { Dropdown } from "./Dropdown";

export interface ActionsMenuItem {
  /** Уникальный идентификатор пункта (можно label или action). */
  key: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
}

/**
 * Кебаб-меню (троеточие) → поповер с действиями. Это просто `Dropdown` в режиме
 * `menu`: использует те же CSS-классы (.dropdown-trigger / .dropdown-menu /
 * .dropdown-option), hover/focus/keyboard/outside-click работают одинаково
 * с обычным селектом.
 */
export function ActionsMenu({
  items,
  ariaLabel = "Действия",
}: {
  items: ActionsMenuItem[];
  ariaLabel?: string;
}) {
  return (
    <Dropdown
      mode="menu"
      menuWidth="auto"
      ariaLabel={ariaLabel}
      className="icon-btn"
      value=""
      options={items.map((it) => ({
        value: it.key,
        label: it.label,
        danger: it.danger,
        icon: it.icon,
      }))}
      onChange={(key) => {
        const it = items.find((i) => i.key === key);
        it?.onClick();
      }}
      triggerProps={{ title: ariaLabel }}
      triggerContent={<MoreVertical size={16} strokeWidth={2} />}
    />
  );
}
