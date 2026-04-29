import { useEffect, useState, useCallback, type ReactElement } from "react";
import { IntegrationLogo } from "../lib/branding.js";

interface Props {
  isDark: boolean;
}

interface Status {
  loaded: boolean;
  permission: "granted" | "denied" | "unknown";
}

interface AppleStatus {
  "apple-reminders": Status;
  "apple-notes": Status;
}

interface Stats {
  count: number;
  items: { name: string; total?: number; count?: number; dueToday?: number; overdue?: number }[];
}

const SLUGS = ["apple-reminders", "apple-notes"] as const;
type Slug = (typeof SLUGS)[number];

const LABELS: Record<Slug, string> = {
  "apple-reminders": "Apple Reminders",
  "apple-notes": "Apple Notes",
};

function permissionBadge(p: Status["permission"], isDark: boolean): ReactElement {
  const map: Record<Status["permission"], { label: string; cls: string }> = {
    granted: { label: "Permission ✓", cls: isDark ? "text-emerald-400" : "text-emerald-600" },
    denied: { label: "Permission ✗", cls: isDark ? "text-rose-400" : "text-rose-600" },
    unknown: { label: "Permission ?", cls: isDark ? "text-amber-400" : "text-amber-600" },
  };
  const { label, cls } = map[p];
  return <span className={`text-xs ${cls}`}>{label}</span>;
}

export function LocalPanel({ isDark }: Props) {
  const [status, setStatus] = useState<AppleStatus | null>(null);
  const [stats, setStats] = useState<Record<Slug, Stats | null>>({
    "apple-reminders": null,
    "apple-notes": null,
  });
  const [busy, setBusy] = useState<Slug | "warmup" | null>(null);

  const refreshStatus = useCallback(async () => {
    const r = await fetch("/api/apple/status");
    if (r.ok) setStatus(await r.json());
  }, []);

  const fetchStats = useCallback(async (slug: Slug) => {
    try {
      const r = await fetch(`/api/apple/stats/${slug}`);
      if (r.ok) {
        const data = await r.json();
        setStats((prev) => ({ ...prev, [slug]: data }));
      }
    } catch {
      // silent — stats are optional eye candy
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    fetchStats("apple-reminders");
    fetchStats("apple-notes");
  }, [refreshStatus, fetchStats]);

  const onTest = async (slug: Slug) => {
    setBusy(slug);
    try {
      await fetch(`/api/apple/test/${slug}`, { method: "POST" });
      await refreshStatus();
      await fetchStats(slug);
    } finally {
      setBusy(null);
    }
  };

  const onWarmup = async () => {
    setBusy("warmup");
    try {
      await fetch("/api/apple/warmup", { method: "POST" });
      await refreshStatus();
      await Promise.all(SLUGS.map((s) => fetchStats(s)));
    } finally {
      setBusy(null);
    }
  };

  const cardCls = isDark
    ? "bg-slate-900/50 border-slate-800"
    : "bg-white border-slate-200";

  return (
    <div className="space-y-4">
      <div>
        <h2 className={`text-lg font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
          Local integrations
        </h2>
        <p className={`text-sm ${isDark ? "text-slate-400" : "text-slate-500"}`}>
          Run on the Mac hosting Boop. macOS-only. No OAuth — uses native AppleScript automation.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {SLUGS.map((slug) => {
          const s = status?.[slug];
          const st = stats[slug];
          const isBusy = busy === slug;
          return (
            <div key={slug} className={`rounded-lg border ${cardCls} p-4`}>
              <div className="flex items-center gap-3 mb-3">
                <IntegrationLogo raw={slug} size={28} />
                <div className="flex-1">
                  <div className={`font-semibold ${isDark ? "text-slate-100" : "text-slate-800"}`}>
                    {LABELS[slug]}
                  </div>
                  <div className="flex gap-2 items-center mt-0.5">
                    <span className={`text-xs ${s?.loaded ? (isDark ? "text-emerald-400" : "text-emerald-600") : (isDark ? "text-slate-500" : "text-slate-400")}`}>
                      {s?.loaded ? "Loaded" : "Not loaded"}
                    </span>
                    <span className={isDark ? "text-slate-600" : "text-slate-300"}>·</span>
                    {s ? permissionBadge(s.permission, isDark) : null}
                  </div>
                </div>
              </div>

              {st && (
                <div className={`text-sm mb-3 ${isDark ? "text-slate-300" : "text-slate-700"}`}>
                  {slug === "apple-reminders" ? (
                    <>
                      {st.count} lists ·{" "}
                      {st.items.reduce((acc, l) => acc + (l.total ?? 0), 0)} reminders ·{" "}
                      {st.items.reduce((acc, l) => acc + (l.dueToday ?? 0), 0)} due today
                    </>
                  ) : (
                    <>
                      {st.count} folders ·{" "}
                      {st.items.reduce((acc, f) => acc + (f.count ?? 0), 0)} notes
                    </>
                  )}
                </div>
              )}

              <button
                onClick={() => onTest(slug)}
                disabled={isBusy}
                className={`text-xs px-3 py-1.5 rounded ${
                  isDark
                    ? "bg-slate-800 hover:bg-slate-700 text-slate-200"
                    : "bg-slate-100 hover:bg-slate-200 text-slate-700"
                } disabled:opacity-50`}
              >
                {isBusy ? "Testing…" : s?.permission === "granted" ? "Test access" : "Grant permission"}
              </button>
            </div>
          );
        })}
      </div>

      <div className={`rounded-lg border ${cardCls} p-4`}>
        <div className={`font-medium mb-2 ${isDark ? "text-slate-100" : "text-slate-800"}`}>
          Setup
        </div>
        <p className={`text-sm mb-3 ${isDark ? "text-slate-400" : "text-slate-500"}`}>
          Click <strong>Permission warmup</strong> to trigger macOS Automation prompts for both
          apps in one go. If a permission ends up denied, fix it in System Settings → Privacy
          &amp; Security → Automation → Node.
        </p>
        <button
          onClick={onWarmup}
          disabled={busy === "warmup"}
          className={`text-sm px-4 py-2 rounded ${
            isDark
              ? "bg-violet-600 hover:bg-violet-500 text-white"
              : "bg-violet-500 hover:bg-violet-600 text-white"
          } disabled:opacity-50`}
        >
          {busy === "warmup" ? "Warming up…" : "Permission warmup"}
        </button>
      </div>
    </div>
  );
}
