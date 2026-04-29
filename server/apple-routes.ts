import { Router } from "express";
import {
  type AppleSlug,
  getCachedPermission,
  probePermission,
  warmupAllPermissions,
} from "./integrations/apple-permissions.js";
import { runOsa } from "./integrations/apple-script.js";
import { buildListListsScript } from "./integrations/apple-reminders.js";
import { buildListFoldersScript } from "./integrations/apple-notes.js";

const SLUGS: AppleSlug[] = ["apple-reminders", "apple-notes"];

interface StatsCacheEntry {
  fetchedAt: number;
  data: unknown;
}
const STATS_CACHE_MS = 60_000;
const statsCache = new Map<AppleSlug, StatsCacheEntry>();

function isAppleSlug(s: string): s is AppleSlug {
  return SLUGS.includes(s as AppleSlug);
}

export function createAppleRouter(): Router {
  const router = Router();

  router.get("/status", async (_req, res) => {
    const out: Record<string, { loaded: boolean; permission: string }> = {};
    for (const slug of SLUGS) {
      out[slug] = {
        loaded: process.platform === "darwin",
        permission: await getCachedPermission(slug),
      };
    }
    res.json(out);
  });

  router.post("/test/:slug", async (req, res) => {
    const slug = req.params.slug;
    if (!isAppleSlug(slug)) {
      res.status(400).json({ error: "unknown slug" });
      return;
    }
    const result = await probePermission(slug);
    res.json(result);
  });

  router.post("/warmup", async (_req, res) => {
    const results = await warmupAllPermissions();
    res.json(results);
  });

  router.get("/stats/:slug", async (req, res) => {
    const slug = req.params.slug;
    if (!isAppleSlug(slug)) {
      res.status(400).json({ error: "unknown slug" });
      return;
    }
    const cached = statsCache.get(slug);
    if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_MS) {
      res.json(cached.data);
      return;
    }
    try {
      const data =
        slug === "apple-reminders"
          ? await runOsa<unknown[]>(buildListListsScript())
          : await runOsa<unknown[]>(buildListFoldersScript());
      const payload = { slug, count: Array.isArray(data) ? data.length : 0, items: data };
      statsCache.set(slug, { fetchedAt: Date.now(), data: payload });
      res.json(payload);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
