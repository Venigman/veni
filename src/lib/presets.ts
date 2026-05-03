import type { AuthKind } from "./storage";

export type EndpointStatus = "ready" | "soon" | "wip" | "broken";

export interface PresetEndpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  label: string;
  /** Optional default body (raw string, usually JSON) prefilled when this endpoint is clicked. */
  body?: string;
  /** Optional status badge: ready=рабочее, soon=заглушка, wip=в работе, broken=сломано. */
  status?: EndpointStatus;
  /** Optional sub-category inside a preset — used to group endpoints in Workspace. */
  category?: string;
}

export interface APIPreset {
  id: string;
  name: string;
  emoji: string;
  category: PresetCategory;
  baseURL: string;
  auth: {
    kind: AuthKind;
    headerName?: string;
    queryName?: string;
    /**
     * Опциональный токен. Хранится локально (localStorage/seed-file).
     * При экспорте через clipboard — автоматически вырезается.
     */
    token?: string;
  };
  defaultHeaders?: Array<{ key: string; value: string }>;
  endpoints: PresetEndpoint[];
  /**
   * Order/list of endpoint sub-categories (for the editor + Workspace accordion).
   * Persists empty categories that don't yet have any endpoints, and gives explicit
   * order. If omitted, derived from endpoints[].category.
   */
  endpointCategories?: string[];
  /** Optional hint shown under preset name (e.g. "ключ в URL") */
  note?: string;
}

export type PresetCategory =
  | "Свои"
  | "AI"
  | "Соцсети"
  | "Мессенджеры"
  | "Видео и музыка"
  | "Карты и погода"
  | "Дев и хостинг"
  | "Платежи"
  | "Email и SMS"
  | "Продуктивность"
  | "Аналитика"
  | "Финансы и крипто"
  | "Медиа и контент"
  | "Перевод"
  | "Открытые API";

export const PRESET_CATEGORIES: PresetCategory[] = [
  "Свои",
  "AI",
  "Соцсети",
  "Мессенджеры",
  "Видео и музыка",
  "Карты и погода",
  "Дев и хостинг",
  "Платежи",
  "Email и SMS",
  "Продуктивность",
  "Аналитика",
  "Финансы и крипто",
  "Медиа и контент",
  "Перевод",
  "Открытые API",
];

export const PRESETS: APIPreset[] = [
];

const USER_PRESETS_KEY = "veni.userPresets.v1";

export function loadUserPresets(): APIPreset[] {
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveUserPresets(list: APIPreset[]) {
  localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(list));
}

/** Filter presets by query (matches name, category, baseURL hostname). */
export function filterPresets(
  query: string,
  source: APIPreset[] = PRESETS
): APIPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return source;
  return source.filter((p) => {
    const haystack = [
      p.name,
      p.category,
      p.baseURL,
      ...p.endpoints.map((e) => e.label),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** Group presets by category, preserving the canonical category order. */
export function groupByCategory(
  list: APIPreset[]
): Array<{ category: PresetCategory; items: APIPreset[] }> {
  const map = new Map<PresetCategory, APIPreset[]>();
  for (const p of list) {
    const arr = map.get(p.category) ?? [];
    arr.push(p);
    map.set(p.category, arr);
  }
  return PRESET_CATEGORIES.filter((c) => map.has(c)).map((c) => ({
    category: c,
    items: map.get(c)!,
  }));
}
