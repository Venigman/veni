import { useState } from "react";
import { Eye, Pencil, LayoutGrid } from "lucide-react";
import { APIsProvider, useAPIs } from "./context/APIs";
import { TabBar } from "./components/TabBar";
import { AddAPIModal } from "./components/AddAPIModal";
import { Workspace } from "./components/Workspace";
import { PresetsPage } from "./components/PresetsPage";

function Shell() {
  const { apis, view, setView } = useAPIs();
  const [addOpen, setAddOpen] = useState(apis.length === 0);

  const onPresets = view === "presets";
  const onWorkspace = view === "workspace";

  // Toggle the page view: clicking the active page button returns to workspace.
  function toggle(target: "presets") {
    setView(view === target ? "workspace" : target);
  }

  return (
    <div className="app-root">
      <div className="topbar">
        <div className="brand">
          <span className="brand-icon">V</span>
          <span className="brand-name">VENI</span>
          <span className="brand-badge">v0.1</span>
        </div>
        <ModeBanner />
        <div className="topbar-spacer" />
        <div className="topbar-actions">
          <button
            type="button"
            className="btn btn--secondary"
            data-active={onPresets}
            onClick={() => toggle("presets")}
            aria-label="Свои пресеты"
            title="Свои пресеты"
          >
            <LayoutGrid size={14} strokeWidth={1.8} />
            <span>Пресеты</span>
          </button>
        </div>
      </div>
      {onWorkspace && <TabBar onAddClick={() => setAddOpen(true)} />}
      {onPresets && <PresetsPage />}
      {onWorkspace && <Workspace />}
      <AddAPIModal open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}

/**
 * Big visual cue for whether the active tab is in read mode (eye)
 * or edit mode (pencil). Driven by the active method via APIs context.
 */
function ModeBanner() {
  const { mode, active, view } = useAPIs();
  // Only meaningful inside the workspace with an active API.
  if (view !== "workspace" || !active) return null;
  const isEdit = mode === "edit";

  return (
    <div
      className="mode-banner"
      data-mode={mode}
      title={isEdit ? "Edit — POST/PUT/PATCH/DELETE" : "Read-only — GET"}
      role="status"
      aria-live="polite"
    >
      {isEdit ? (
        <Pencil size={13} strokeWidth={2} />
      ) : (
        <Eye size={13} strokeWidth={2} />
      )}
      <span className="mode-banner-label">{isEdit ? "Edit" : "Read"}</span>
    </div>
  );
}

export function App() {
  return (
    <APIsProvider>
      <Shell />
    </APIsProvider>
  );
}
