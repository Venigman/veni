/**
 * AI-агент для авто-генерации пресетов.
 *
 * Ключ юзера живёт ТОЛЬКО в localStorage. В коде/репо — никаких токенов.
 * Прямой fetch к Anthropic Messages API с заголовком dangerous-direct-browser-access
 * (Anthropic официально разрешает браузерные вызовы при наличии этого хедера).
 */
import type { APIPreset, PresetEndpoint } from "./presets";

const KEY_STORAGE = "veni.ai.key.v1";
const PROVIDER_STORAGE = "veni.ai.provider.v1";
const MODEL_STORAGE = "veni.ai.model.v1";

export type AIProvider = "anthropic";

export interface AIConfig {
  provider: AIProvider;
  apiKey: string;
  model: string;
}

const DEFAULT_MODEL = "claude-haiku-4-5";

export function loadAIConfig(): AIConfig | null {
  const apiKey = localStorage.getItem(KEY_STORAGE);
  if (!apiKey) return null;
  return {
    provider: (localStorage.getItem(PROVIDER_STORAGE) as AIProvider) || "anthropic",
    apiKey,
    model: localStorage.getItem(MODEL_STORAGE) || DEFAULT_MODEL,
  };
}

export function saveAIConfig(cfg: AIConfig) {
  localStorage.setItem(KEY_STORAGE, cfg.apiKey);
  localStorage.setItem(PROVIDER_STORAGE, cfg.provider);
  localStorage.setItem(MODEL_STORAGE, cfg.model);
}

export function clearAIConfig() {
  localStorage.removeItem(KEY_STORAGE);
  localStorage.removeItem(PROVIDER_STORAGE);
  localStorage.removeItem(MODEL_STORAGE);
}

/* ───────────────────────────────────────────────────────────
   Tool-use loop для генерации пресета.
   Модель добавляет endpoints через тулзу add_endpoint,
   мы стримим их обратно в UI через onEndpoint callback.
   ─────────────────────────────────────────────────────────── */

interface GenerateOptions {
  apiName: string;
  baseURL: string;
  authKind: APIPreset["auth"]["kind"];
  authHeaderName?: string;
  authQueryName?: string;
  /**
   * Опциональный токен. Если задан — ИИ может использовать тулзу
   * probe_endpoint чтобы реально дёргать API GET-запросами и видеть
   * структуру ответов. Токен НЕ сохраняется в пресет.
   */
  probeToken?: string;
  signal?: AbortSignal;
  onEndpoint: (ep: PresetEndpoint) => void;
  onCategories?: (cats: string[]) => void;
  onProgress?: (msg: string) => void;
}

export async function generatePreset(opts: GenerateOptions): Promise<{
  added: number;
  finalText: string;
  noRestApi?: string;
}> {
  const cfg = loadAIConfig();
  if (!cfg) throw new Error("AI не настроен — введи ключ в Настройки → ИИ");

  const tools = [
    {
      name: "add_endpoint",
      description:
        "Добавить ОДНО действие (эндпоинт) в пресет. Вызывай по одной штуке для каждого полезного эндпоинта API.",
      input_schema: {
        type: "object" as const,
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          },
          path: {
            type: "string",
            description: "Путь относительно baseURL, например /users/me",
          },
          label: {
            type: "string",
            description:
              "Короткий человекочитаемый лейбл на русском (3-7 слов)",
          },
          category: {
            type: "string",
            description: "Категория действия — короткая русская группа",
          },
          body: {
            type: "string",
            description:
              "Опциональный JSON-body для POST/PUT/PATCH. Пример: {\"name\":\"value\"}",
          },
        },
        required: ["method", "path", "label", "category"],
      },
    },
    ...(opts.probeToken
      ? [
          {
            name: "probe_endpoint",
            description:
              "Сделать реальный GET-запрос к этому API (с авторизацией пользователя) чтобы посмотреть какие данные возвращает. Используй для разведки — например GET / или GET /v1 — чтобы найти существующие пути и понять структуру ответов. ТОЛЬКО GET, без побочных эффектов.",
            input_schema: {
              type: "object" as const,
              properties: {
                path: {
                  type: "string",
                  description:
                    "Путь относительно baseURL, например /user, /v1/me, /repos",
                },
              },
              required: ["path"],
            },
          },
        ]
      : []),
    {
      name: "report_no_rest_api",
      description:
        "Вызови если у этого сервиса НЕТ публичного HTTP REST API (например Framer, Figma — только desktop SDK; Webflow для не-Enterprise; и т.д.). Это сигнал юзеру что пресет создавать бесполезно.",
      input_schema: {
        type: "object" as const,
        properties: {
          reason: {
            type: "string",
            description:
              "Короткое объяснение на русском почему REST API нет (1-2 фразы). Пример: 'У Framer нет публичного REST API — только Plugin API внутри редактора.'",
          },
        },
        required: ["reason"],
      },
    },
  ];

  const systemPrompt = `Ты — помощник по созданию пресетов для VENI (универсального API-клиента).

Юзер подключил API: **${opts.apiName}**
- baseURL: ${opts.baseURL}
- авторизация: ${opts.authKind}${opts.authHeaderName ? ` (header: ${opts.authHeaderName})` : ""}${opts.authQueryName ? ` (query: ${opts.authQueryName})` : ""}

ПРАВИЛА (КРИТИЧНО — соблюдай строго):
1. Используй ТОЛЬКО endpoints которые ты ТОЧНО знаешь по документации. Не «логичные» пути, не «обычно бывает», а реально существующие.
2. **СТОП-СПИСОК — у этих сервисов НЕТ публичного REST API для управления, ВСЕГДА вызывай report_no_rest_api:**
   - Framer (api.framer.com) — есть только Plugin API внутри редактора
   - Apple Notes / iCloud — нет публичного API
   - Tinder, Instagram (для рядовых юзеров) — закрыты
   - Любой сервис где документация упоминает только SDK/Plugin/iframe-embed без HTTP-эндпоинтов
3. Если ты сомневаешься хотя бы немного в существовании API — вызови report_no_rest_api с честным «не уверен что у сервиса есть публичный REST». Лучше пустой пресет чем галлюцинации.
4. ${opts.probeToken ? "У тебя есть токен и тулза probe_endpoint — ОБЯЗАТЕЛЬНО сделай 1-2 пробных GET-запроса (например GET / или GET /v1/me) чтобы убедиться что API живой и понять структуру. ТОЛЬКО ПОСЛЕ probe — генерируй endpoints на основе того что увидел." : "У тебя НЕТ возможности проверить API. Если baseURL не из списка хорошо известных (GitHub, OpenAI, Anthropic, Telegram, Stripe, Notion, Slack, Discord-OAuth, Linear, Twilio, SendGrid, Cloudflare, Spotify, Twitch) — вызывай report_no_rest_api."}
5. Реально-проверенные API: GitHub (/user, /repos/{o}/{r}, ...), OpenAI (/v1/chat/completions, /v1/models), Anthropic (/v1/messages), Telegram Bot (/bot{token}/sendMessage), Stripe (/v1/customers, /v1/charges), Notion (/v1/pages, /v1/databases), Slack (/api/chat.postMessage), Spotify (/v1/me, /v1/playlists), Twitch Helix (/helix/users), и т.п.
${opts.probeToken ? `5. У ТЕБЯ ЕСТЬ ТУЛЗА probe_endpoint — реально дёргает API GET'ом с токеном юзера. ИСПОЛЬЗУЙ ЕЁ для разведки (1-3 раза): пробуй базовые пути типа /, /user, /v1, /me чтобы увидеть что API реально умеет. На основе ответа — точные endpoints.\n6. probe_endpoint только для GET. Не делай destructive операций.` : ""}

Если API реальный, то:
1. Подумай какие действия наиболее ценны (без редких/служебных)
2. Сгруппируй на 3-6 логических категорий (короткие русские: "Профиль", "Репозитории", "Сообщения", "Платежи")
3. Вызови add_endpoint для каждого полезного эндпоинта (10-25 штук оптимально)
4. Лейблы — короткие, на русском, человечные ("Мой профиль", "Создать репо", не "GET /user/repos")
5. Для POST/PUT/PATCH — body с примером (валидный JSON)
6. В конце — короткое резюме (1-2 фразы)`;

  const messages: Array<Record<string, unknown>> = [
    { role: "user", content: "Сгенерируй пресет для этого API." },
  ];

  let added = 0;
  let lastText = "";
  let noRestApi: string | null = null;
  const seenCategories = new Set<string>();

  for (let iter = 0; iter < 8; iter++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    opts.onProgress?.(`Шаг ${iter + 1} — отправляю запрос…`);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = (await res.json()) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      stop_reason: string;
    };

    // Сохраняем assistant turn в messages.
    messages.push({ role: "assistant", content: data.content });

    // Обрабатываем tool_use блоки.
    const toolResults: Array<{ type: string; tool_use_id: string; content: string }> = [];
    for (const block of data.content) {
      if (block.type === "text" && block.text) {
        lastText = block.text;
      }
      if (block.type === "tool_use" && block.name === "probe_endpoint" && block.id && opts.probeToken) {
        const inp = (block.input ?? {}) as { path?: string };
        const path = (inp.path || "").trim();
        if (!path.startsWith("/")) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: "path должен начинаться с /" });
          continue;
        }
        const url = opts.baseURL.replace(/\/+$/, "") + path;
        const headers: Record<string, string> = { "Accept": "application/json" };
        if (opts.authKind === "bearer") {
          headers["Authorization"] = `Bearer ${opts.probeToken}`;
        } else if (opts.authKind === "header" && opts.authHeaderName) {
          headers[opts.authHeaderName] = opts.probeToken;
        }
        opts.onProgress?.(`Пробую ${path}…`);
        let probeResult = "";
        try {
          const probeURL =
            opts.authKind === "query" && opts.authQueryName
              ? `${url}${path.includes("?") ? "&" : "?"}${opts.authQueryName}=${encodeURIComponent(opts.probeToken)}`
              : url;
          const r = await fetch(probeURL, { method: "GET", headers, signal: opts.signal });
          const text = await r.text();
          probeResult = `HTTP ${r.status}\n\n${text.slice(0, 1500)}${text.length > 1500 ? "\n…(обрезано)" : ""}`;
        } catch (e) {
          probeResult = `Ошибка fetch: ${(e as Error).message}`;
        }
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: probeResult });
        continue;
      }
      if (block.type === "tool_use" && block.name === "report_no_rest_api" && block.id) {
        const reason = ((block.input ?? {}) as { reason?: string }).reason || "REST API нет";
        noRestApi = reason;
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: "noted",
        });
        continue;
      }
      if (block.type === "tool_use" && block.name === "add_endpoint" && block.id) {
        const input = (block.input ?? {}) as {
          method?: string;
          path?: string;
          label?: string;
          category?: string;
          body?: string;
        };
        if (input.method && input.path && input.label && input.category) {
          const ep: PresetEndpoint = {
            method: input.method as PresetEndpoint["method"],
            path: input.path,
            label: input.label,
            category: input.category,
            body: input.body || undefined,
            status: "ready",
          };
          opts.onEndpoint(ep);
          if (!seenCategories.has(input.category)) {
            seenCategories.add(input.category);
            opts.onCategories?.(Array.from(seenCategories));
          }
          added += 1;
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "added",
          });
        } else {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: "missing_fields",
          });
        }
      }
    }

    if (data.stop_reason === "end_turn") break;
    if (toolResults.length === 0) break; // ничего не сделала — выходим
    messages.push({ role: "user", content: toolResults });
  }

  return {
    added,
    finalText: lastText,
    ...(noRestApi ? { noRestApi } : {}),
  };
}
