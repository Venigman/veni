export type AuthKind = "none" | "bearer" | "header" | "query";

export type EndpointStatus = "ready" | "soon" | "wip" | "broken";

export interface SavedEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  label: string;
  body?: string;
  status?: EndpointStatus;
  category?: string;
}

export interface APITab {
  id: string;
  name: string;
  baseURL: string;
  auth: {
    kind: AuthKind;
    headerName?: string;
    queryName?: string;
    token?: string;
  };
  defaultHeaders: Array<{ key: string; value: string }>;
  endpoints?: SavedEndpoint[];
  /** Order of endpoint sub-categories — used by Workspace accordion. */
  endpointCategories?: string[];
  /** Optional preset id this tab was created from (for re-applying presets later). */
  presetId?: string;
  createdAt: number;
}

export interface HistoryItem {
  id: string;
  apiId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  at: number;
}

const APIS_KEY = "veni.apis.v1";
const ACTIVE_KEY = "veni.activeId.v1";
const HISTORY_KEY = "veni.history.v1";

export function loadAPIs(): APITab[] {
  try {
    const raw = localStorage.getItem(APIS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveAPIs(apis: APITab[]) {
  localStorage.setItem(APIS_KEY, JSON.stringify(apis));
}

export function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function saveActiveId(id: string | null) {
  if (id) localStorage.setItem(ACTIVE_KEY, id);
  else localStorage.removeItem(ACTIVE_KEY);
}

export function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveHistory(items: HistoryItem[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, 200)));
}

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
