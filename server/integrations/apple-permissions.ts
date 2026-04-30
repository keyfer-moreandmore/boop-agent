import { api } from "../../convex/_generated/api.js";
import { convex } from "../convex-client.js";
import { runOsa, OsaError } from "./apple-script.js";
import { buildListListsScript } from "./apple-reminders.js";
import { buildListFoldersScript } from "./apple-notes.js";

export type PermissionStatus = "granted" | "denied" | "unknown";
export type AppleSlug = "apple-reminders" | "apple-notes";

interface CacheEntry {
  status: PermissionStatus;
  checkedAt: number;
  durationMs: number;
}

const memoryCache = new Map<AppleSlug, CacheEntry>();
const STALE_MS = 60 * 60 * 1000; // 1h

const PROBES: Record<AppleSlug, () => string> = {
  "apple-reminders": buildListListsScript,
  "apple-notes": buildListFoldersScript,
};

function settingKey(slug: AppleSlug): string {
  return `${slug}.permission`;
}

async function loadFromConvex(slug: AppleSlug): Promise<PermissionStatus> {
  const v = await convex.query(api.settings.get, { key: settingKey(slug) });
  if (v === "granted" || v === "denied") return v;
  return "unknown";
}

async function persist(slug: AppleSlug, status: PermissionStatus): Promise<void> {
  await convex.mutation(api.settings.set, { key: settingKey(slug), value: status });
}

export async function getCachedPermission(slug: AppleSlug): Promise<PermissionStatus> {
  const mem = memoryCache.get(slug);
  if (mem && Date.now() - mem.checkedAt < STALE_MS) return mem.status;
  const persisted = await loadFromConvex(slug);
  if (persisted !== "unknown") {
    memoryCache.set(slug, { status: persisted, checkedAt: Date.now(), durationMs: 0 });
  }
  return persisted;
}

export async function probePermission(slug: AppleSlug): Promise<{
  status: PermissionStatus;
  durationMs: number;
  sample?: unknown;
  errorMessage?: string;
}> {
  const start = Date.now();
  const buildScript = PROBES[slug];
  try {
    const sample = await runOsa(buildScript(), { timeoutMs: 5_000 });
    const durationMs = Date.now() - start;
    memoryCache.set(slug, { status: "granted", checkedAt: Date.now(), durationMs });
    await persist(slug, "granted");
    return { status: "granted", durationMs, sample };
  } catch (err) {
    const durationMs = Date.now() - start;
    if (err instanceof OsaError && err.kind === "permission") {
      memoryCache.set(slug, { status: "denied", checkedAt: Date.now(), durationMs });
      await persist(slug, "denied");
      return { status: "denied", durationMs, errorMessage: err.message };
    }
    memoryCache.set(slug, { status: "unknown", checkedAt: Date.now(), durationMs });
    return {
      status: "unknown",
      durationMs,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function warmupAllPermissions(): Promise<
  Record<AppleSlug, Awaited<ReturnType<typeof probePermission>>>
> {
  const slugs: AppleSlug[] = ["apple-reminders", "apple-notes"];
  const results = {} as Record<AppleSlug, Awaited<ReturnType<typeof probePermission>>>;
  for (const slug of slugs) {
    results[slug] = await probePermission(slug);
  }
  return results;
}
