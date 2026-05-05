import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRESETS_FILE = resolve(__dirname, "data/claude-presets.json");

interface Endpoint {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  label: string;
  body?: string;
}

interface Preset {
  id: string;
  name: string;
  emoji?: string;
  category?: string;
  baseURL: string;
  auth: { kind: string; headerName?: string; queryName?: string };
  defaultHeaders?: Array<{ key: string; value: string }>;
  endpoints: Endpoint[];
  note?: string;
}

async function readPresets(): Promise<Preset[]> {
  try {
    return JSON.parse(await readFile(PRESETS_FILE, "utf8"));
  } catch {
    return [];
  }
}

async function writePresets(list: Preset[]): Promise<void> {
  await writeFile(PRESETS_FILE, JSON.stringify(list, null, 2) + "\n");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Tiny JSON-over-HTTP API used by Claude (running in another process via curl)
 * to manage VENI presets without blowing away the whole file.
 *
 * Whole-preset ops:
 *   GET    /api/presets                       — list
 *   POST   /api/presets         body=Preset   — upsert by id
 *   PUT    /api/presets         body=Preset[] — replace all
 *   DELETE /api/presets?id=X                  — remove preset
 *
 * Per-endpoint ops (нужны чтобы Claude мог точечно править строки):
 *   POST   /api/presets/endpoint?id=X            body=Endpoint
 *                                                — append; idempotent on label
 *   POST   /api/presets/endpoint?id=X&insert=N   body=Endpoint
 *                                                — insert at index N
 *   DELETE /api/presets/endpoint?id=X&index=N    — remove by 0-based index
 *   DELETE /api/presets/endpoint?id=X&label=Y    — remove first match by label
 *   PATCH  /api/presets/endpoint?id=X&index=N    body=partial Endpoint
 *                                                — merge into endpoint
 *   PATCH  /api/presets?id=X                     body=partial Preset
 *                                                — merge top-level fields
 */
export default defineConfig({
  // Relative paths so the build works both at site root and at a subpath
  // like /veni-hub/ (GitHub Pages serves project repos from a subpath).
  base: "./",
  plugins: [
    react(),
    {
      name: "claude-presets-api",
      configureServer(server) {
        server.middlewares.use(
          "/api/presets",
          async (req: IncomingMessage, res: ServerResponse, next) => {
            try {
              const url = new URL(req.url ?? "/", "http://localhost");
              const isEndpointResource = url.pathname.startsWith("/endpoint");

              // ── per-endpoint operations ─────────────────────
              if (isEndpointResource) {
                const id = url.searchParams.get("id");
                if (!id) {
                  send(res, 400, { error: "?id required" });
                  return;
                }
                const list = await readPresets();
                const preset = list.find((p) => p.id === id);
                if (!preset) {
                  send(res, 404, { error: `preset ${id} not found` });
                  return;
                }

                if (req.method === "POST") {
                  const ep = JSON.parse(await readBody(req)) as Endpoint;
                  if (!ep || !ep.method || !ep.path || !ep.label) {
                    send(res, 400, {
                      error: "endpoint requires method/path/label",
                    });
                    return;
                  }
                  const insertParam = url.searchParams.get("insert");
                  if (insertParam !== null) {
                    const idx = Math.max(
                      0,
                      Math.min(preset.endpoints.length, parseInt(insertParam, 10))
                    );
                    preset.endpoints.splice(idx, 0, ep);
                  } else {
                    preset.endpoints.push(ep);
                  }
                  await writePresets(list);
                  send(res, 200, {
                    ok: true,
                    total: preset.endpoints.length,
                    appended: ep.label,
                  });
                  return;
                }

                if (req.method === "DELETE") {
                  const indexParam = url.searchParams.get("index");
                  const labelParam = url.searchParams.get("label");
                  let removed: Endpoint | undefined;
                  if (indexParam !== null) {
                    const idx = parseInt(indexParam, 10);
                    if (idx < 0 || idx >= preset.endpoints.length) {
                      send(res, 400, { error: `index ${idx} out of range` });
                      return;
                    }
                    [removed] = preset.endpoints.splice(idx, 1);
                  } else if (labelParam !== null) {
                    const idx = preset.endpoints.findIndex(
                      (e) => e.label === labelParam
                    );
                    if (idx === -1) {
                      send(res, 404, {
                        error: `endpoint with label "${labelParam}" not found`,
                      });
                      return;
                    }
                    [removed] = preset.endpoints.splice(idx, 1);
                  } else {
                    send(res, 400, { error: "?index or ?label required" });
                    return;
                  }
                  await writePresets(list);
                  send(res, 200, {
                    ok: true,
                    removed: removed?.label,
                    total: preset.endpoints.length,
                  });
                  return;
                }

                if (req.method === "PATCH") {
                  const indexParam = url.searchParams.get("index");
                  if (indexParam === null) {
                    send(res, 400, { error: "?index required" });
                    return;
                  }
                  const idx = parseInt(indexParam, 10);
                  if (idx < 0 || idx >= preset.endpoints.length) {
                    send(res, 400, { error: `index ${idx} out of range` });
                    return;
                  }
                  const patch = JSON.parse(await readBody(req)) as Partial<Endpoint>;
                  preset.endpoints[idx] = { ...preset.endpoints[idx], ...patch };
                  await writePresets(list);
                  send(res, 200, {
                    ok: true,
                    endpoint: preset.endpoints[idx],
                  });
                  return;
                }

                send(res, 405, { error: "method not allowed on /endpoint" });
                return;
              }

              // ── whole-preset operations ─────────────────────
              if (req.method === "GET") {
                send(res, 200, await readPresets());
                return;
              }
              if (req.method === "POST") {
                const body = await readBody(req);
                const incoming = JSON.parse(body) as Preset;
                if (!incoming || typeof incoming.id !== "string") {
                  send(res, 400, { error: "preset.id required" });
                  return;
                }
                const list = await readPresets();
                const idx = list.findIndex((p) => p.id === incoming.id);
                if (idx === -1) list.push(incoming);
                else list[idx] = incoming;
                await writePresets(list);
                send(res, 200, { ok: true, count: list.length });
                return;
              }
              if (req.method === "PATCH") {
                const id = url.searchParams.get("id");
                if (!id) {
                  send(res, 400, { error: "?id required" });
                  return;
                }
                const list = await readPresets();
                const preset = list.find((p) => p.id === id);
                if (!preset) {
                  send(res, 404, { error: `preset ${id} not found` });
                  return;
                }
                const patch = JSON.parse(await readBody(req)) as Partial<Preset>;
                Object.assign(preset, patch);
                await writePresets(list);
                send(res, 200, { ok: true, preset });
                return;
              }
              if (req.method === "DELETE") {
                const id = url.searchParams.get("id");
                if (!id) {
                  send(res, 400, { error: "?id required" });
                  return;
                }
                const list = await readPresets();
                const next = list.filter((p) => p.id !== id);
                await writePresets(next);
                send(res, 200, { ok: true, removed: list.length - next.length });
                return;
              }
              if (req.method === "PUT") {
                const list = JSON.parse(await readBody(req)) as Preset[];
                if (!Array.isArray(list)) {
                  send(res, 400, { error: "body must be an array" });
                  return;
                }
                await writePresets(list);
                send(res, 200, { ok: true, count: list.length });
                return;
              }
              next();
            } catch (err) {
              send(res, 500, { error: String(err) });
            }
          }
        );
      },
    },
  ],
  server: {
    host: "0.0.0.0",
    port: 5180,
    allowedHosts: [".ts.net", "localhost"],
  },
});
